import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { Command } from 'commander'
import pc from 'picocolors'
import { resolveConfig, loadConfigPlugins, mergeWithTestConfig, mergeUseBlocks, formatConfigDebug, loadEnvOverrides } from '../config.js'
import { ATTR_GATE_RUN, ATTR_RUNNER, ATTR_TRIGGER, AUTH_STATE_SCHEMA_VERSION, buildInternalRunAttributes, DEFAULT_AGENT_QA_ARTIFACTS_DIR, DEFAULT_AGENT_QA_RUNS_DB_PATH, DEFAULT_AGENT_QA_CACHE_DIR, formatRunAttributesBlock, generateRunId, getAgentQaVersion, isCanonicalRunId, mergeRunAttributes, MobileSetupError, normalizeAuthStateUse, parseRunAttrFlags, resolveAuthStateForRun, resolveAuthStatePaths, resolveKnowledgeRoot, resolveMobileRunConfig } from '@vostride/agent-qa-core'
import { discoverWorkspaceFiles, isWorkspacePathMatch, resolveWorkspaceFileTarget, resolveWorkspacePaths, workspaceRelativeIdentityPath } from '@vostride/agent-qa-core'
import { printRunText } from '@vostride/agent-qa-core/run-text-output'
import type { AgentQaConfig, AuthStateMetadata, MemberLogScope, NormalizedAuthStateUse, ResolvedAuthStateForRun, ResolvedAuthStatePaths, ResolvedMobileDevice, ResolvedMobileRunConfig, ResolvedWorkspacePaths, RunAttributes, RunAttributeRunner, RunAttributeTrigger, WorkspaceFileKind, WorkspaceFileRecord } from '@vostride/agent-qa-core'
import { createModel, createTokenAccounting, resolveCapabilities, resolveVisionConfig, resolveVisionGate, visionFromConfig } from '@vostride/agent-qa-model'
import { resolveTarget, type ResolvedTarget } from '../targets.js'
import { loadLocalBindings, type LocalDeviceBindings } from '../devices.js'
import { resolveLLMModels, resolveModelAuth, toModelProfileAndAuth } from '../llm-utils.js'
import { formatInstallBrowsersRetryCommand, type BrowserInstallSelection } from './install-browsers.js'
import type { ParsedTestBinding, TestDefinition, ParseError, SuiteDefinition, SuiteResult, RunSuiteConfig } from '@vostride/agent-qa-core'
import {
  asRunId,
  DEFAULT_NAVIGATION_TIMEOUT_MS,
  maskPayloadStrings,
  resolvePlannerLimits,
  type PlannerLimitsRecord,
} from '@vostride/agent-qa-schema'
import { memberPlannerConfig, plannerLimitsInfoLines, plannerLimitsRecord, type MemberPlannerConfig, type MemberPlannerLimits } from '../run-planner-limits.js'
import type {
  DeclaredModelProfile,
  MaskFn,
  ModelCapabilities,
  QuarantineAppliedEntry,
  RunArtifactStageInput,
  RunEventEnvelope,
  RunFinishedPayload,
  RunSession,
  RunStatus,
  VerdictPayload,
} from '@vostride/agent-qa-schema'
import type { DashboardDatabase, RunIdentityMember } from '@vostride/agent-qa-dashboard'
import type { SecretStore, SecretRedactor, SecretRedactorPort, HookDefinition, NonActionToolMap, SandboxRunnerOptions } from '@vostride/agent-qa-runner'
import { DockerHookExecutor } from '@vostride/agent-qa-runner-local'
import type { TestResult, PlatformAdapter, PlatformConfig } from '@vostride/agent-qa-runner'
import { WorkingMemoryStore, runMemberTest, createStepModelScope, memberStepText, redactSecretValue } from '@vostride/agent-qa-runner'
import { createCliStepModelScopeFactory } from '../composition/step-model-scope.js'
import type { CliStepModelScopeOptions } from '../composition/step-model-scope.js'
import type { RunMemberDescriptor, ConfigDigests, MemberTestRunContext, MemberTestExecutor, StepModelScopeFactory } from '@vostride/agent-qa-runner'
// the run-start ledger fold lives at the local composition root (the CLI's shipped source
// does not name the knowledge package — 387 D-20); this host calls the ONE resolved helper.
import { resolveRunQuarantineSnapshot } from '@vostride/agent-qa-agent-local'
// the door renders the core's refusal; it no longer COMPOSES the core. That moved,
// with the assembler hand-off, the audit sink, the safety-hook runner and the safety scope, into the ONE in-process drive both of this door's paths now call.
import { RunIdAlreadyInUseError, RunIdNotMintedError } from '@vostride/agent-qa-agent-local'
// the ONE in-process drive. BOTH of this door's paths are callers of it — the door supplies
// its posture, its members and its post-verdict tail; the drive owns the order.
//
// DEFERRED, NOT STATIC. `in-process-run-execution.ts` imports this file's producers relatively (the
// surface firewall's answer for vocabulary that may not leave `commands/run.ts`), so a static import
// here closes an ESM cycle at module-evaluation time. A call-time `await import` keeps every edge in
// that cycle a call-time edge, which is the condition under which ESM tolerates one at all.
import type { runInProcessCliRun as RunInProcessCliRun } from '../composition/in-process-run-execution.js'
// the typed input failure this file's preflight now THROWS instead of exiting on.
// It lives in a leaf module rather than in `in-process-run-execution.ts` because that module
// imports this one's producers — see `cli-run-input-error.ts`'s header.
import { CliRunInputError } from '../composition/cli-run-input-error.js'
import { DeclaredSecretsUnavailableError, readDeclaredSecrets } from '../composition/declared-secrets.js'
import { composeRunOwnership } from '../composition/run-owner-probe.js'
import {
  buildMemberRunConfig,
  buildRunPorts,
  buildScreenshotCompressor,
  buildSuiteMemberExecutor,
  registerAdapterLiveStream,
  computeRunConfigDigests,
  createSuiteLifecycle,
  SUITE_LIFECYCLE_LANE,
  memoryToolGate,
  openRunKnowledgeComposition,
  resolveBuildTagSetting,
  resolveHostRetrievalRung,
  resolveRunBuildOrdinal,
  resolveRunExecutionContext,
  toMemberTest,
  type RunKnowledgeComposition,
  type RunSubscriberHandle,
  type SuiteMemberBinding,
} from '@vostride/agent-qa-agent-local'
import {
  attachRunSubscribers,
  buildAnalyticsRunSubscriber,
} from '../run-session-composition.js'
import { composeAnalyticsHost } from '../composition/analytics-host.js'
import type { CliAnalyticsHost } from '../composition/analytics-host.js'
import {
  runVerdictFirstCurationTail,
  unexpectedCurationTailWarning,
  type CurationTailModelDeps,
} from '../curation/curation-tail.js'
import { composeCliPostRunTail } from '../curation/post-run-tail-composition.js'
import { flushWorkingMemory } from '../wm-flush.js'
import { isPathInsideDir } from '@vostride/agent-qa-core'
import { createShutdownController } from './shutdown-controller.js'
import { buildDirectRunMembers } from './direct-run-members.js'
import { resolveRecordingSetting, resolveRecordingStagingDir } from './recording-setting.js'
import { printAgentQaUpdateNoticeIfNeeded, shouldPrintAgentQaUpdateNotice, type AgentQaUpdateNoticeContext } from '../version-notice.js'

const RUNTIME_ARTIFACTS_DIR = DEFAULT_AGENT_QA_ARTIFACTS_DIR || '.agent-qa/artifacts'
const RUNTIME_CACHE_DIR = DEFAULT_AGENT_QA_CACHE_DIR || '.agent-qa/cache'

/** Model/runner capabilities stay on the existing authorized CLI import boundary. */
export interface RunStepModelPorts {
  createModel: typeof createModel
  createScope: typeof createStepModelScope
}

function bindMemberStepModelScope(ctx: MemberTestRunContext, create: StepModelScopeFactory) {
  if (ctx.runId === undefined) throw new Error('Observed model usage requires the run shell to supply its canonical runId.')
  return { runId: ctx.runId, create }
}

export interface InvocationProductMember {
  label: string
  product: string
}

/**
 * CompletedRunHandoff owns one product scope and one product-local build ordinal. Until that
 * contract is partitioned, accepting more than one product would misattribute every later member.
 */
export function requireSingleInvocationProduct(
  members: readonly InvocationProductMember[],
): string | undefined {
  const labelsByProduct = new Map<string, string[]>()
  for (const member of members) {
    const product = member.product.trim()
    if (product.length === 0) continue
    const labels = labelsByProduct.get(product) ?? []
    labels.push(member.label)
    labelsByProduct.set(product, labels)
  }

  const products = [...labelsByProduct.keys()].sort()
  if (products.length <= 1) return products[0]

  const detail = products
    .map((product) => `${product} (${labelsByProduct.get(product)!.join(', ')})`)
    .join('; ')
  throw new Error(
    `Mixed-product run is not supported: ${detail}. Run each product in a separate agent-qa run invocation.`,
  )
}

/**
 * WHAT ONE INVOCATION'S MEMBERS SAY ABOUT THEIR TARGETS — resolved once, per member, for both of
 * this command's doors.
 *
 * INDEX-ALIGNED WITH THE MEMBER LIST, which is the whole point: `probeUrls` decides which health
 * reading belongs to which member. A run-level probe URL — the FIRST resolvable web member's,
 * applied to everyone — is what let a baseline taken against member B's target be recorded as
 * member A's environment failure. A member naming no target contributes `undefined`.
 */
export interface MemberTargetFacts {
  /** One entry per member, in member order: the URL to probe, or `undefined` for no probe. */
  readonly probeUrls: readonly (string | undefined)[]
  /** The first member whose target resolved — the invocation's product when nothing else names it. */
  readonly firstResolvedProduct?: string
}

export function resolveMemberTargetFacts(
  config: AgentQaConfig,
  memberTargetNames: readonly (string | undefined)[],
): MemberTargetFacts {
  const probeUrls: (string | undefined)[] = []
  let firstResolvedProduct: string | undefined

  for (const targetName of memberTargetNames) {
    if (targetName === undefined) {
      probeUrls.push(undefined)
      continue
    }
    try {
      const resolved = resolveTarget(config, targetName)
      // web targets only. A mobile member contributes no URL and therefore receives no
      // baseline — the device-session-create failure is the equivalent environment signal there.
      probeUrls.push(resolved.platform === 'web' && resolved.url ? resolved.url : undefined)
      firstResolvedProduct ??= resolved.product
    } catch {
      // Best-effort resolution: the member closure still surfaces the real target error as the
      // framework error it is.
      probeUrls.push(undefined)
    }
  }

  return {
    probeUrls,
    ...(firstResolvedProduct === undefined ? {} : { firstResolvedProduct }),
  }
}

/**
 * Every post-run line's CHANNEL, in one place — and exported because the channel is a promise.
 *
 * Post-processing never gates the verdict or the navigation, so no post-run line lands on stdout,
 * where the reporter and the navigation live: both members write to stderr. Under GitHub Actions
 * each line prints inside its own stop-commands pair on stdout instead, like all run-derived text.
 * Exported so the byte-proof binds THIS object rather than a copy of it: a proof against a
 * re-declared log would keep passing on the day somebody routes a close-out line to `console.log`.
 */
export const curationTailLog = {
  warn(message: string): void {
    printRunText(pc.yellow(`Warning: ${message}`), (text) => console.warn(text))
  },
  // The per-run candidate summary line: the same stderr channel as warn, so the ladder run log
  // captures it, but never dressed as a warning.
  info(message: string): void {
    printRunText(message, (text) => console.error(text))
  },
}

// SESSION-04 force-exit backstop grace window. Primary guarantee is the shell settling `done`
// cleanly on cancel/budget (Plan 361-13 Task 2); this is a hard safety net so a genuinely
// un-settleable run still exits 130 and a live Ctrl+C can never hang the CLI. Overridable via env
// for tests. The armed timer is `.unref()`d — it never keeps the loop alive on its own, but still
// fires if a wedged run is keeping the loop alive.
function cancelGraceMs(): number {
  return Number(process.env.AGENT_QA_CANCEL_GRACE_MS ?? 3000)
}

// CI vendor-var set reused for the CachePolicy.isCI resolution at the composition root
// (mirrors safety-local's execution-context-detector set — D-14). Kept inline so the CLI
// does not take a new cross-package dependency purely to read env markers.
const CI_VENDOR_VARS = [
  'CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'CIRCLECI', 'TRAVIS', 'APPVEYOR', 'BUILDKITE',
  'DRONE', 'JENKINS_URL', 'HUDSON_URL', 'BITBUCKET_BUILD_NUMBER', 'TEAMCITY_VERSION',
] as const

function resolveIsCI(env: NodeJS.ProcessEnv = process.env): boolean {
  return CI_VENDOR_VARS.some((name) => {
    const value = env[name]
    return value !== undefined && value !== '' && value.toLowerCase() !== 'false' && value !== '0'
  })
}

/**
 * Composition-root construction of the redesigned action cache.
 * Builds the runner-local `FsActionCache` behind a resolved branch `CachePolicy`, injected into the
 * runner loop's cache port via RunTest/RunSuite config.
 */
async function buildActionCacheContext(params: {
  cacheDir: string
  disableCache: boolean
  saveCache: boolean
  protectedBranches?: string[]
}): Promise<{ cache: import('@vostride/agent-qa-runner').ActionPlanCache }> {
  const { FsActionCache, resolveBranch } = await import('@vostride/agent-qa-runner-local')
  const branch = resolveBranch({ cwd: process.cwd() })
  const cache = new FsActionCache({
    root: params.cacheDir,
    policy: {
      currentBranch: branch.currentBranch,
      defaultBranch: branch.defaultBranch,
      protectedBranches: [branch.defaultBranch, ...(params.protectedBranches ?? [])],
      isCI: resolveIsCI(),
      saveCache: params.saveCache,
      disableCache: params.disableCache,
    },
  })
  return { cache }
}

/**
 * Composition-root construction of the run-scoped storage-state store. Builds
 * the runner-local `FsStorageStateStore` rooted at the run's `.agent-qa` runtime dir (the
 * FsActionCache rooting idiom) — the raw-but-local auth-persistence home under
 * `.agent-qa/storage-states/`. Injected into the runner loop's `storageState` port; all fs writes
 * stay in runner-local (arch lint: storageNeutral).
 */
async function buildStorageStateStore(configDir: string): Promise<import('@vostride/agent-qa-runner').StorageStatePort> {
  const { FsStorageStateStore } = await import('@vostride/agent-qa-runner-local')
  const { resolve } = await import('node:path')
  return new FsStorageStateStore({ root: resolve(configDir, '.agent-qa') })
}

let _appiumManager: InstanceType<typeof import('@vostride/agent-qa-dashboard').AppiumManager> | null = null

/**
 * An already-running Appium a HOST leased for this run, or the environment's own override.
 *
 * INJECTED SINCE 401-07, and the injection is what removes the last reason a dashboard run needed a
 * child process. The dashboard owns a bundled Appium and leases it per run (design-of-record — the
 * spawn stays); it used to hand the URL to `agent-qa run` through `AGENT_QA_APPIUM_URL` in the
 * child's environment, and a child environment is something only a child has. The resolver is that
 * same fact with the child removed: the host answers with the URL it leased, and this producer
 * takes it in place of the env read.
 *
 * THE ENV READ STAYS as the fallback, because it is also a USER's knob — `AGENT_QA_APPIUM_URL`
 * points a local run at an Appium somebody else is running, and that has nothing to do with the
 * dashboard. Injected first, env second, bundled last: most specific answer wins.
 */
export type AppiumUrlResolver = () => string | undefined

/**
 * THE ONE PRECEDENCE RULE for "which Appium is this run talking to": injected, then the
 * environment, then the bundled auto-start below. Exported so the order is a cell's subject rather
 * than three copies of an `??` chain — it is read at four sites, and three of them decide the
 * `managed` flag, which is what tells a teardown whether it owns the server it is talking to.
 */
export function resolveHostAppiumUrl(resolveAppiumUrl?: AppiumUrlResolver): string | undefined {
  return resolveAppiumUrl?.() ?? process.env.AGENT_QA_APPIUM_URL
}

async function acquireAppium(
  logLevel: string,
  resolveAppiumUrl?: AppiumUrlResolver,
): Promise<string | undefined> {
  const provided = resolveHostAppiumUrl(resolveAppiumUrl)
  if (provided) return provided
  const { AppiumManager } = await import('@vostride/agent-qa-dashboard')
  if (!_appiumManager) {
    _appiumManager = new AppiumManager({
      logLevel: logLevel === 'debug' ? 'debug' : 'normal',
    })
  }
  await _appiumManager.acquire()
  return _appiumManager.getUrl()
}

function releaseAppium(): void {
  _appiumManager?.release()
}

export async function createPlatformAdapter(
  platform: 'web' | 'android' | 'ios',
  options: { readonly hostOwnsSignals?: true } = {},
): Promise<PlatformAdapter> {
  if (platform === 'android') {
    try {
      const { AndroidPlatformAdapter } = await import('@vostride/agent-qa-android')
      return new AndroidPlatformAdapter()
    } catch {
      throw new Error(
        'Android adapter not available. Install @vostride/agent-qa-android: pnpm add @vostride/agent-qa-android',
      )
    }
  }
  if (platform === 'ios') {
    try {
      const { IOSPlatformAdapter } = await import('@vostride/agent-qa-ios')
      return new IOSPlatformAdapter()
    } catch {
      throw new Error(
        'iOS adapter not available. Install @vostride/agent-qa-ios: pnpm add @vostride/agent-qa-ios',
      )
    }
  }
  const { WebPlatformAdapter } = await import('@vostride/agent-qa-web')
  return new WebPlatformAdapter(options.hostOwnsSignals === true ? { hostOwnsSignals: true } : {})
}

const runWebAccessibilityCheck: NonNullable<RunSuiteConfig['accessibilityCheck']> = async (page, options) => {
  const { runAccessibilityCheck } = await import('@vostride/agent-qa-web')
  return runAccessibilityCheck(page as any, options)
}

export function buildPlatformConfig(
  platform: 'web' | 'android' | 'ios',
  resolvedDevice: ResolvedMobileDevice | undefined,
  timeouts: PlatformConfig['timeouts'],
  globalBrowser?: { name?: string; headless?: boolean; viewport?: { width: number; height: number } },
  logCapture?: { console?: boolean; network?: boolean },
  mobileResolved?: ResolvedMobileRunConfig,
): PlatformConfig {
  if (platform === 'web') {
    return {
      platform: 'web',
      browser: {
        name: (globalBrowser?.name as 'chromium' | 'firefox' | 'webkit') ?? 'chromium',
        headless: globalBrowser?.headless ?? true,
        viewport: globalBrowser?.viewport,
      },
      timeouts,
      logCapture,
    }
  }
  return {
    platform,
    device: resolvedDevice ? {
      name: resolvedDevice.name,
      platform: resolvedDevice.platform,
      match: resolvedDevice.match,
    } : undefined,
    bundleId: mobileResolved?.app.bundleId,
    appPackage: mobileResolved?.app.appPackage,
    appActivity: mobileResolved?.app.appActivity,
    deepLinkAppId: mobileResolved?.app.deepLinkAppId,
    appState: mobileResolved?.appState,
    appPath: mobileResolved?.app.install?.path,
    appiumUrl: mobileResolved?.appium.url,
    timeouts,
    logCapture,
  }
}

type WebBrowserName = 'chromium' | 'firefox' | 'webkit'

interface FormattedFrameworkError {
  displayMessage: string
  failureSummary: string
}

function inferMissingBrowser(message: string): WebBrowserName | null {
  const lower = message.toLowerCase()
  if (/(^|[/\\])webkit-\d/.test(lower) || lower.includes('webkit')) return 'webkit'
  if (/(^|[/\\])firefox-\d/.test(lower) || lower.includes('firefox')) return 'firefox'
  if (/(^|[/\\])chromium-\d/.test(lower) || lower.includes('chromium')) return 'chromium'
  return null
}

function isRawPlaywrightMissingBrowserError(message: string): boolean {
  const lower = message.toLowerCase()
  return lower.includes("executable doesn't exist")
    && lower.includes('playwright')
    && lower.includes('install')
}

function formatBrowserInstallSelection(browserName: WebBrowserName | null): BrowserInstallSelection {
  if (browserName === 'chromium') return { chromium: true }
  if (browserName === 'firefox') return { firefox: true }
  if (browserName === 'webkit') return { webkit: true }
  return { all: true }
}

function browserDisplayName(browserName: WebBrowserName | null): string {
  if (browserName === 'chromium') return 'Chromium'
  if (browserName === 'firefox') return 'Firefox'
  if (browserName === 'webkit') return 'WebKit'
  return 'the selected browser'
}

function formatMissingBrowserFrameworkError(message: string): FormattedFrameworkError | null {
  const browserName = inferMissingBrowser(message)
  const retryCommand = formatInstallBrowsersRetryCommand(formatBrowserInstallSelection(browserName))
  const alreadyFriendly = message.startsWith('agent-qa browser support is not installed')

  if (!alreadyFriendly && !isRawPlaywrightMissingBrowserError(message)) return null

  const displayMessage = alreadyFriendly
    ? message
    : [
      `agent-qa browser support is not installed for ${browserDisplayName(browserName)}.`,
      '',
      'Install the browser managed by agent-qa, then rerun the test:',
      `  ${retryCommand}`,
      '',
      'This can happen after upgrading agent-qa or Playwright because browser binaries live outside the package install.',
    ].join('\n')

  return {
    displayMessage,
    failureSummary: `Browser support missing: run ${retryCommand}`,
  }
}

function formatFrameworkError(message: string): FormattedFrameworkError {
  return formatMissingBrowserFrameworkError(message) ?? {
    displayMessage: `Framework error: ${message}`,
    failureSummary: `Framework error: ${message.slice(0, 200)}`,
  }
}

// 2026-10-15 (441-63, CR-A03): the terminal copy is masked like the copy written to the database.
export function frameworkErrorTerminalLine(
  message: string,
  redactor: SecretRedactorPort | undefined,
): string {
  return redactSecretValue(formatFrameworkError(message).displayMessage, redactor)
}

export interface RunOptions {
  browser?: string
  platform?: string
  buildTag?: string
  headless?: boolean
  disableCache?: boolean
  saveCache?: boolean
  dryRun?: boolean
  listTests?: boolean
  junitOutput?: string
  screenshotMode?: string
  reporter?: string[]
  record?: boolean
  configDebug?: boolean
  test?: boolean
  suite?: boolean
  all?: boolean
  device?: string
  var?: string[]
  runAttr?: string[]
  detach?: boolean
  gateRun?: boolean
  excludedFromOutcomes?: boolean
  /** `--parallel` / `--no-parallel`, an ordinary override of `use.parallel`. */
  parallel?: boolean
  /** `--workers <count>`, an ordinary override of `use.workers`. Argv is a string. */
  workers?: string
}

/**
 * The two durable run markers — this command's options mapped onto the two request fields (393
 * WTST-06; re-aimed at `RunsStartInput` by 401-03/401-04).
 *
 * WHAT THIS FUNCTION IS FOR, AFTER THE MIGRATION. The marker chain used to be
 * request → port → child argv → command flag → `RunConfig`; on the invocation core it is
 * request → `RunConfig`, mapped on ONE line inside `run-invocation-core.ts`. What survives here is
 * the OTHER half — the half a person types. `--gate-run` and `--excluded-from-outcomes` are argv,
 * and argv has to become request fields somewhere; this is that somewhere, spelled once for BOTH of
 * this command's paths (Pitfall 8's rule applied to markers: a second literal spread would be a
 * second place for the two paths to disagree about whether a run was a gate-run, and the outcome
 * fold's exclusion reads the handoff either path wrote).
 *
 * Only literal `true` marks; a `false` or an absent flag leaves the field ABSENT. That is what the
 * carriers' `?: true` type requires, what `RunsStartInputSchema`'s `z.literal(true)` REFUSES a
 * `false` for, and what `AnalyzeRunPayloadSchema` refuses a literal `false` for downstream — three
 * independent statements of the same rule, which is why `false` may never be quietly coerced here.
 */
export function runMarkers(opts: RunOptions): { gateRun?: true; excludedFromOutcomes?: true } {
  return {
    ...(opts.gateRun === true ? { gateRun: true as const } : {}),
    ...(opts.excludedFromOutcomes === true ? { excludedFromOutcomes: true as const } : {}),
  }
}

/**
 * THE RUN'S CONCURRENCY CONFIG — read at the producer, never from a request.
 *
 * IT IS AN ORDINARY `use`-BUCKET OVERRIDE AND NOTHING ELSE. The two flags ride `mergeUseBlocks`,
 * the same helper and the same precedence (`config.use` < flags) every other `use` override in
 * this command follows, so there is no second merge to disagree with the first. What comes back is
 * the RAW pair; the COUNT is decided later and in exactly one place, by `resolveEffectiveWorkers`.
 *
 * IT READS THE PROJECT CONFIG'S `use`, NOT A SUITE'S OR A TEST'S. Concurrency is a property of the
 * whole run — one pool serves every member — so a per-member tier would be N answers to a
 * run-level question. A suite or test YAML that sets `use.parallel` is therefore not honoured here;
 * that is a deliberate scope line, recorded in this plan's SUMMARY rather than silently implied.
 *
 * A `--workers` FLAG THAT IS NOT A POSITIVE INTEGER IS A USAGE ERROR, refused with the config
 * contract's exit code rather than coerced — `Number.parseInt('abc')` is `NaN`, and a NaN that
 * quietly became the default would be a person's typo answered with a guess.
 */
export function resolveRunConcurrencyConfig(
  configUse: Record<string, unknown> | undefined,
  opts: RunOptions,
  memberUses: readonly (Record<string, unknown> | undefined)[] = [],
): { parallel?: boolean; workers?: number } {
  const flagOverrides: Record<string, unknown> = {}
  if (opts.parallel !== undefined) flagOverrides['parallel'] = opts.parallel
  if (opts.workers !== undefined) {
    const parsed = Number.parseInt(opts.workers, 10)
    if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== opts.workers.trim()) {
      throw new CliRunInputError(
        [pc.red(`Error: --workers must be a positive integer (got "${opts.workers}").`)],
        2,
      )
    }
    flagOverrides['workers'] = parsed
  }

  const merged = mergeUseBlocks(configUse, undefined, undefined, flagOverrides)
  // A MEMBER'S OWN OPT-OUT MAKES THE WHOLE RUN SEQUENTIAL, and most-restrictive-wins is why it
  // beats both the config and the flags.
  //
  // COARSE, AND DELIBERATELY SO. `use.parallel: false` in a test's own YAML is a claim that THAT
  // test must not run beside another, and the only mechanism that could honour it precisely — a
  // barrier in the member scheduler — lives in `shell.ts`, which this plan does not own (402-04
  // does, this wave). The choice was therefore between honouring the opt-out for the whole run and
  // silently repealing it the moment a project turned `use.parallel` on; a shipped cell in
  // `run.test.ts` asserts the barrier, and an opt-out that quietly stopped opting out is the worse
  // of the two. The finer per-member form is filed rather than approximated.
  const memberOptOut = memberUses.some((use) => use?.['parallel'] === false)
  return {
    ...(memberOptOut
      ? { parallel: false }
      : typeof merged['parallel'] === 'boolean' ? { parallel: merged['parallel'] } : {}),
    ...(typeof merged['workers'] === 'number' ? { workers: merged['workers'] } : {}),
  }
}

const SUPPORTED_REPORTERS = ['console', 'junit', 'stdout-live'] as const
type ReporterName = typeof SUPPORTED_REPORTERS[number]

interface ReporterSelection {
  console: boolean
  junit: boolean
  stdoutLive: boolean
}

export interface SecretsFileArtifactMetadata {
  path: string | null
  status: 'loaded' | 'missing' | 'unreadable' | 'invalid'
  count?: number
}

export interface RuntimeSecretsContext {
  secretStore: SecretStore
  secretRedactor: SecretRedactor
  secretsFileMetadata: SecretsFileArtifactMetadata
}

function parseVarFlags(flags: string[] | undefined): Record<string, string> {
  if (!flags) return {}
  const vars: Record<string, string> = {}
  for (const kv of flags) {
    const eqIdx = kv.indexOf('=')
    if (eqIdx === -1) {
      console.warn(`Warning: --var "${kv}" missing =, ignored`)
      continue
    }
    vars[kv.slice(0, eqIdx)] = kv.slice(eqIdx + 1)
  }
  return vars
}

function buildCliRunAttributes(userAttributes: RunAttributes, runner: RunAttributeRunner): RunAttributes {
  return mergeRunAttributes(
    buildInternalRunAttributes({ trigger: 'cli', runner }),
    userAttributes,
  )
}

// The trigger and runner the analytics subscriber is told are read from the attributes this
// command resolved for the run.
function analyticsRunAttribution(
  attributes: RunAttributes,
): { triggerSource?: string; runner?: string } {
  const triggerSource = attributes[ATTR_TRIGGER]
  const runner = attributes[ATTR_RUNNER]
  return {
    ...(typeof triggerSource === 'string' ? { triggerSource } : {}),
    ...(typeof runner === 'string' ? { runner } : {}),
  }
}

function printRunAttributes(attributes: RunAttributes | undefined): void {
  if (!attributes || Object.keys(attributes).length === 0) return
  const block = formatRunAttributesBlock(attributes)
  if (block) printRunText(block, (text) => console.log(text))
}

function resolveReporterSelection(opts: RunOptions): { selection?: ReporterSelection; error?: string } {
  const requested = opts.reporter
    ?.flatMap((name) => name.split(','))
    .map((name) => name.trim())
    .filter(Boolean)

  if (!requested?.length) {
    return {
      selection: {
        console: true,
        junit: Boolean(opts.junitOutput),
        stdoutLive: process.env.AGENT_QA_LIVE_EVENTS === 'true',
      },
    }
  }

  for (const name of requested) {
    if (!SUPPORTED_REPORTERS.includes(name as ReporterName)) {
      return { error: `Unknown reporter "${name}". Supported reporters: ${SUPPORTED_REPORTERS.join(', ')}` }
    }
  }

  const selected = new Set(requested as ReporterName[])
  if (selected.has('junit') && !opts.junitOutput) {
    return { error: '--reporter junit requires --junit-output <path>' }
  }

  return {
    selection: {
      console: selected.has('console'),
      junit: selected.has('junit'),
      stdoutLive: selected.has('stdout-live'),
    },
  }
}

function isSnapshotRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A run's loaded test/suite and config snapshot, masked with the run's own context (433-29,
 * G-433-5). The bus carries no snapshots; this channel is how a door's dashboard ingest gets them.
 */
export interface RunArtifactSnapshot {
  readonly config?: Record<string, unknown>
  readonly source?: Record<string, unknown>
}

export type RunArtifactSnapshotListener = (snapshot: RunArtifactSnapshot) => void

interface RunArtifactSnapshotChannel {
  emit(snapshot: RunArtifactSnapshot): void
  /** Every snapshot emitted so far is replayed, so a listener registered late still gets each once. */
  subscribe(listener: RunArtifactSnapshotListener): () => void
}

function createRunArtifactSnapshotChannel(): RunArtifactSnapshotChannel {
  const emitted: RunArtifactSnapshot[] = []
  const listeners = new Set<RunArtifactSnapshotListener>()
  const deliver = (listener: RunArtifactSnapshotListener, snapshot: RunArtifactSnapshot): void => {
    try {
      listener(snapshot)
    } catch {
      // A listener's failure is never the run's (the dashboard ingest is best-effort).
    }
  }
  return {
    emit(snapshot) {
      emitted.push(snapshot)
      for (const listener of [...listeners]) deliver(listener, snapshot)
    },
    subscribe(listener) {
      listeners.add(listener)
      for (const snapshot of emitted) deliver(listener, snapshot)
      return () => { listeners.delete(listener) }
    },
  }
}

function maskRunArtifactSnapshot(
  artifact: Record<string, unknown>,
  masking: { mask(text: string): string },
): RunArtifactSnapshot {
  const mask = (text: string): string => masking.mask(text)
  return {
    ...(isSnapshotRecord(artifact.config) ? { config: maskPayloadStrings(artifact.config, mask) } : {}),
    ...(isSnapshotRecord(artifact.source) ? { source: maskPayloadStrings(artifact.source, mask) } : {}),
  }
}

// The run's `artifact.json`: its source as written, masked with the run's mask, and the sorted
// target names its tests ran on. Target names are config registry keys and are written as they are.
function stagedRunArtifact(
  source: Record<string, unknown>,
  targetNames: readonly (string | undefined)[],
  mask: MaskFn,
): RunArtifactStageInput {
  const masked = maskRunArtifactSnapshot({ source }, { mask }).source
  return {
    ...(masked === undefined ? {} : { source: masked }),
    targets: [...new Set(targetNames.filter((name): name is string => !!name))].sort(),
  }
}

function suiteRunSource(
  artifacts: readonly (Record<string, unknown> | undefined)[],
): Record<string, unknown> {
  const sources = artifacts
    .map((artifact) => artifact?.source)
    .filter((source): source is Record<string, unknown> => isSnapshotRecord(source))
  return sources.length === 1 ? sources[0]! : { kind: 'suites', suites: sources }
}

function directRunSource(bindings: readonly ParsedTestBinding[]): Record<string, unknown> {
  const snapshot = ({ test, filePath, fileContent }: ParsedTestBinding) => ({
    testId: test['test-id'] ?? null,
    name: test.name,
    filePath,
    rawYaml: fileContent || null,
    resolvedDefinition: test,
    loadStatus: 'loaded',
  })
  if (bindings.length === 1) return { kind: 'test', ...snapshot(bindings[0]!) }
  return {
    kind: 'tests',
    members: bindings.map((binding, index) => ({
      index,
      ref: {
        test: binding.filePath,
        ...(binding.test['test-id'] === undefined ? {} : { id: binding.test['test-id'] }),
      },
      target: binding.test.target,
      ...snapshot(binding),
    })),
  }
}

// the one run-record builder. It lives here because this file is the
// CLI's only ledgered home for the dashboard package (FUNC-02 surface firewall).
export interface RunRecordHostBinding {
  readonly db: DashboardDatabase
  queueRun(runId: string): { readonly attributes?: RunAttributes } | undefined
}

export interface RunRecordAttach {
  readonly mask: MaskFn
  readonly members: readonly RunIdentityMember[]
  readonly attributes?: RunAttributes
  readonly onMemberSnapshot?: (listener: RunArtifactSnapshotListener) => () => void
  readonly snapshots?: { readonly config?: unknown; readonly source?: unknown }
  readonly gateRun?: boolean
}

export interface RunRecord {
  open(input: { runId: string; configDir: string; configuredDbPath?: string }): Promise<void>
  readonly db: DashboardDatabase | undefined
  subscriber(attach: RunRecordAttach): {
    handler(envelope: RunEventEnvelope): void
    flush(): Promise<void>
  }
  ownRowId(): string | undefined
  close(): void
}

export class RunRecordUnavailableError extends Error {
  readonly dbPath: string

  constructor(dbPath: string, cause: unknown) {
    super(
      cause instanceof Error && cause.name === 'RunsDatabaseVersionRefusedError'
        ? `${cause.message} The run was not started.`
        : `agent-qa could not open the runs database at ${dbPath}, so the run was not started: `
          + `${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
    this.name = 'RunRecordUnavailableError'
    this.dbPath = dbPath
  }
}

export function doorRunAttributes(trigger: RunAttributeTrigger): RunAttributes {
  return buildInternalRunAttributes({ trigger, runner: 'local' })
}

function isOwnRunningRowOrFree(db: DashboardDatabase, runId: string): boolean {
  const row = db.getRun(runId)
  if (row === undefined) return true
  const owner = db.readRunOwner(runId)
  return row.status === 'running' && owner !== undefined && db.isOwnStamp(runId, owner)
}

// 2026-10-17 (443-15, GAP-D5): a path that does not exist yet (or `:memory:`) has no real path.
function namesOneRunsDb(a: string, b: string): boolean {
  try {
    return realpathSync.native(a) === realpathSync.native(b)
  } catch {
    return resolvePath(a) === resolvePath(b)
  }
}

export function createRunRecord(input: {
  readonly attributes: RunAttributes
  readonly host?: RunRecordHostBinding
  readonly warn: (line: string) => void
}): RunRecord {
  let dashboard: typeof import('@vostride/agent-qa-dashboard') | undefined
  let db: DashboardDatabase | undefined
  let ownsDb = false
  let openedFor: string | undefined
  let opening: { readonly runId: string; readonly done: Promise<void> } | undefined
  let ownRow: string | undefined
  let incompleteReason: string | undefined
  let closed = false
  const refuseClosed = (): Error => new Error('This run record is closed.')

  const openOnce = async ({ runId, configDir, configuredDbPath }: Parameters<RunRecord['open']>[0]) => {
    const host = input.host
    let dbPath = resolvePath(configDir, configuredDbPath?.trim() || DEFAULT_AGENT_QA_RUNS_DB_PATH)
    let useHost = false
    let handle: DashboardDatabase
    let free: boolean
    // a runs.db that cannot be opened refuses the run before any effect.
    try {
      dashboard = await import('@vostride/agent-qa-dashboard')
      dbPath = dashboard.resolveDashboardDbPath({
        configDir,
        ...(configuredDbPath === undefined ? {} : { configuredDbPath }),
      })
      useHost = host !== undefined
        && (host.queueRun(runId) !== undefined || namesOneRunsDb(host.db.dbPath, dbPath))
      handle = useHost && host !== undefined
        ? host.db
        : new dashboard.DashboardDatabase({ dbPath, runOwnership: composeRunOwnership() })
    } catch (error) {
      throw new RunRecordUnavailableError(dbPath, error)
    }
    // a close that landed during the open releases the handle it built.
    if (closed) {
      if (!useHost) handle.close()
      throw refuseClosed()
    }
    try {
      free = isOwnRunningRowOrFree(handle, runId)
    } catch (error) {
      if (!useHost) handle.close()
      throw new RunRecordUnavailableError(dbPath, error)
    }
    if (!free) {
      if (!useHost) handle.close()
      throw new RunIdAlreadyInUseError(runId)
    }
    db = handle
    openedFor = runId
    ownsDb = !useHost
  }

  return {
    get db() {
      return db
    },
    async open(args) {
      if (closed) throw refuseClosed()
      if (opening !== undefined) {
        if (opening.runId === args.runId) return opening.done
        throw new Error(`This run record belongs to ${opening.runId} and cannot open ${args.runId}.`)
      }
      // 2026-10-17 (443-review, IN-07): a concurrent open joins the one in flight; a failed one binds nothing.
      const done = openOnce(args).catch((error: unknown) => {
        opening = undefined
        throw error
      })
      opening = { runId: args.runId, done }
      return done
    },
    subscriber(attach) {
      if (db === undefined || dashboard === undefined || openedFor === undefined) {
        throw new Error('A run record was attached before it was opened.')
      }
      const runId = openedFor
      const queued = input.host?.queueRun(runId)
      // 2026-10-17 (443-14, GAP-D3): the queue's attributes win; else the producer's, under the
      // door's trigger; else the door's own.
      const own = queued !== undefined
        ? queued.attributes
        : attach.attributes === undefined
          ? input.attributes
          : { ...attach.attributes, [ATTR_TRIGGER]: input.attributes[ATTR_TRIGGER] }
      // a verify run's row is marked from the run's own gate-run flag.
      const attributes = attach.gateRun === true
        ? { ...(own ?? db.getRun(runId)?.attributes), [ATTR_GATE_RUN]: 'true' }
        : own
      const mask = (value: unknown): any => (isSnapshotRecord(value)
        ? maskPayloadStrings(value, attach.mask)
        : undefined)
      const ingest = dashboard.createDashboardRunIngest({
        db,
        runId,
        configSnapshot: mask(attach.snapshots?.config),
        sourceSnapshot: mask(attach.snapshots?.source),
        members: attach.members.map((member) => ({
          ...member,
          name: attach.mask(member.name),
          filePath: attach.mask(member.filePath),
          ...(member.suiteName === undefined ? {} : { suiteName: attach.mask(member.suiteName) }),
        })),
        ...(attributes === undefined ? {} : { attributes }),
        onRunCreated: (created) => { ownRow = created },
      })
      const unsubscribe = attach.onMemberSnapshot?.((snapshot) => { ingest.stageSnapshots(snapshot) })
      const handle = db
      let stopped = false
      let flushed = false
      let verdict: RunStatus | undefined
      const stop = (reason: string): void => {
        stopped = true
        incompleteReason ??= reason
      }
      return {
        handler(envelope) {
          const payload = envelope.payload as Partial<VerdictPayload & RunFinishedPayload> | undefined
          if (envelope.type === 'verdict' && typeof payload?.verdict === 'string') verdict = payload.verdict
          if (envelope.type === 'runFinished' && typeof payload?.aggregateVerdict === 'string') {
            verdict = payload.aggregateVerdict
          }
          if (stopped) return
          try {
            ingest.handler(envelope)
          } catch (error) {
            stop(error instanceof Error ? error.message : String(error))
            return
          }
          if (envelope.type === 'runStarted' && ownRow === undefined) {
            stop('another agent-qa process owns its row')
          }
        },
        flush: async () => {
          if (flushed) return
          flushed = true
          unsubscribe?.()
          if (!stopped) {
            try {
              await ingest.finalize()
            } catch (error) {
              stop(error instanceof Error ? error.message : String(error))
            }
          }
          stopped = true
          // no verdict closes the own row as failed, guessing no cause.
          if (verdict === undefined && ownRow !== undefined) {
            try {
              const startedMs = Date.parse(handle.getRun(runId)?.startedAt ?? '')
              handle.finalizeOwnRun(runId, {
                status: 'failed',
                endedAt: new Date().toISOString(),
                ...(Number.isNaN(startedMs) ? {} : { duration: Math.max(0, Date.now() - startedMs) }),
                failureSummary: 'The run ended before it reached a verdict.',
              })
            } catch {
              // A runs.db that will not take the close leaves the row to orphan cleanup.
            }
          }
          if (incompleteReason === undefined) return
          // the verdict stands; the run's own row is closed once, best effort.
          if (verdict !== undefined && ownRow !== undefined) {
            try {
              handle.closeOwnRun(runId, { status: verdict, endedAt: new Date().toISOString() })
            } catch {
              // The warning below already says the record is incomplete.
            }
          }
          input.warn(
            `The run finished (${verdict ?? 'without a verdict'}), but its dashboard record is incomplete: `
              + `${incompleteReason}.`,
          )
        },
      }
    },
    ownRowId: () => ownRow,
    close() {
      closed = true
      if (ownsDb) db?.close()
      ownsDb = false
    },
  }
}

// only a forced exit closes a row, and only this process's still-running one.
export function closeOwnRowAtForcedExit(record: RunRecord): void {
  const id = record.ownRowId()
  if (record.db === undefined || id === undefined) return
  try {
    record.db.finalizeOwnRun(id, {
      status: 'cancelled',
      endedAt: new Date().toISOString(),
      failureSummary: 'The run was stopped before it reached a verdict.',
    })
  } catch {
    // The process is exiting; a wedged runs.db must not stop it.
  }
}

async function maybePrintPostRunUpdateNotice(context: AgentQaUpdateNoticeContext): Promise<void> {
  try {
    if (!shouldPrintAgentQaUpdateNotice(context)) return
    await printAgentQaUpdateNoticeIfNeeded(context)
  } catch {
    // Update notices are best-effort and must not affect run outcomes.
  }
}

/**
 * The rendered parse-error report, as LINES rather than as console writes.
 *
 * an input refusal CARRIES what it used to print, so the door that has a terminal renders
 * it and a door that has none does something else with it. `formatParseErrors` below is now this
 * function plus a loop, which is what keeps the two from drifting into two reports.
 */
function formatParseErrorLines(errors: ParseError[]): string[] {
  const lines: string[] = []
  for (const err of errors) {
    const location = `${err.file}:${err.line}:${err.column}`
    const severity = err.severity === 'error' ? pc.red('error') : pc.yellow('warning')
    lines.push(`${severity}: ${err.message}`)
    lines.push(`  ${pc.blue('-->')} ${location}`)
    if (err.source) {
      lines.push(`  ${pc.blue('|')} ${err.source}`)
    }
    if (err.suggestion) {
      lines.push(`  ${pc.blue('=')} ${pc.bold('help')}: ${err.suggestion}`)
    }
    lines.push('')
  }
  return lines
}

function formatParseErrors(errors: ParseError[]): void {
  const lines = formatParseErrorLines(errors)
  if (lines.length > 0) printRunText(lines.join('\n'), (text) => console.error(text))
}

function createTestRunId(): string {
  return process.env.AGENT_QA_RUN_ID ?? generateRunId()
}

function printRunId(runId: string | null | undefined): void {
  if (runId) console.log(`Run ID: ${runId}`)
}

/** What a producer may print; only `agent-qa run` passes one, since other doors' stdout is a protocol. */
export interface RunTerminal {
  printRunId(runId: string): void
  printRunAttributes(attributes: RunAttributes): void
  printDebugLine(line: string): void
}

const RUN_TERMINAL: RunTerminal = {
  printRunId,
  printRunAttributes,
  printDebugLine: (line) => printRunText(pc.dim(line), (text) => console.log(text)),
}

// Printed at the terminal door only, before the first test and at every log level. A test's own
// limits quote its name, so that block prints through the run-text helper. The producers never
// print: the MCP host's stdout is its JSON-RPC connection.
function printPlannerLimits(record: PlannerLimitsRecord | undefined): void {
  if (record === undefined) return
  const text = plannerLimitsInfoLines(record).join('\n')
  if ((record.perTest ?? []).length > 0) {
    printRunText(text, (block) => console.log(block))
    return
  }
  console.log(text)
}

function isGlobLikePattern(value: string): boolean {
  return /[*?[{]/.test(value)
}

function classifyRunPattern(pattern: string): WorkspaceFileKind {
  return pattern.includes('.suite.') ? 'suite' : 'test'
}

function matchesCliWorkspacePattern(
  workspace: ResolvedWorkspacePaths,
  kind: WorkspaceFileKind,
  pattern: string,
  record: WorkspaceFileRecord,
): boolean {
  const patternWorkspace = {
    ...workspace,
    testMatch: kind === 'test' ? [pattern] : workspace.testMatch,
    suiteMatch: kind === 'suite' ? [pattern] : workspace.suiteMatch,
  }
  return isWorkspacePathMatch({
    workspace: patternWorkspace,
    kind,
    workspaceRelativePath: record.workspaceRelativePath,
  })
}

async function discoverFilesForCliPatterns(
  workspace: ResolvedWorkspacePaths,
  patterns: string[],
): Promise<{ tests: string[]; suites: string[] }> {
  const testRecords = await discoverWorkspaceFiles({ workspace, kind: 'test' })
  const suiteRecords = await discoverWorkspaceFiles({ workspace, kind: 'suite' })
  const discoveredByKind: Record<WorkspaceFileKind, WorkspaceFileRecord[]> = {
    test: testRecords,
    suite: suiteRecords,
  }
  const selectedByKind: Record<WorkspaceFileKind, Map<string, WorkspaceFileRecord>> = {
    test: new Map(),
    suite: new Map(),
  }
  const seenKinds = new Set<WorkspaceFileKind>()

  for (const pattern of patterns) {
    const kind = classifyRunPattern(pattern)
    seenKinds.add(kind)

    if (isGlobLikePattern(pattern)) {
      for (const record of discoveredByKind[kind]) {
        if (matchesCliWorkspacePattern(workspace, kind, pattern, record)) {
          selectedByKind[kind].set(record.workspaceRelativePath, record)
        }
      }
      continue
    }

    const record = await resolveWorkspaceFileTarget({
      workspace,
      kind,
      filePath: pattern,
      requireExisting: true,
    })
    selectedByKind[kind].set(record.workspaceRelativePath, record)
  }

  if (seenKinds.size > 1) {
    throw new Error('Cannot mix suite files and test patterns in the same run')
  }

  return {
    tests: [...selectedByKind.test.values()].map(record => record.absolutePath),
    suites: [...selectedByKind.suite.values()].map(record => record.absolutePath),
  }
}

function buildHooksArtifact(hooks?: Map<string, HookDefinition>): Array<{ id: string; name: string; runtime?: string; sourcePath?: string }> {
  if (!hooks) return []
  return [...hooks.values()].map((hook) => ({
    id: hook.id,
    name: hook.name,
    runtime: (hook as any).runtime,
    sourcePath: (hook as any).path ?? (hook as any).sourcePath,
  }))
}

function secretsRefusal(err: DeclaredSecretsUnavailableError): CliRunInputError {
  const [first = '', ...rest] = err.lines
  return new CliRunInputError([pc.red(first), ...rest.map((line) => pc.dim(line))], 1)
}

/**
 * `agent-qa.local.yaml`, read at most once per run. A file the loader refuses becomes an input
 * refusal, so the producer can read it before the run is recorded whenever a member runs on a
 * device.
 */
function createRunLocalBindingsReader(): () => LocalDeviceBindings | null {
  let read: { readonly bindings: LocalDeviceBindings | null } | undefined
  return () => {
    if (read === undefined) {
      try {
        read = { bindings: loadLocalBindings() }
      } catch (err) {
        const [first = '', ...rest] = (err instanceof Error ? err.message : String(err)).split('\n')
        throw new CliRunInputError(
          [pc.red(`Config error: ${first}`), ...rest.map((line) => pc.dim(line))],
          1,
        )
      }
    }
    return read.bindings
  }
}

function anyTargetRunsOnDevice(
  config: AgentQaConfig,
  targetNames: readonly (string | undefined)[],
): boolean {
  return targetNames.some((targetName) => {
    if (targetName === undefined) return false
    try {
      const platform = resolveTarget(config, targetName).platform
      return platform === 'android' || platform === 'ios'
    } catch {
      // The member closure reports an unresolvable target itself.
      return false
    }
  })
}

async function loadRuntimeSecrets(input: {
  config: AgentQaConfig
  configDir: string
  secretsFilePath?: string
}): Promise<RuntimeSecretsContext> {
  const configuredSecretsFile = (input.config as any).workspace?.secretsFile
  if (typeof configuredSecretsFile !== 'string' || configuredSecretsFile.trim().length === 0) {
    throw secretsRefusal(DeclaredSecretsUnavailableError.required())
  }

  const secretsPath = input.secretsFilePath ?? resolvePath(input.configDir, configuredSecretsFile)
  let secretStore: SecretStore
  try {
    secretStore = readDeclaredSecrets(secretsPath)
  } catch (err) {
    if (err instanceof DeclaredSecretsUnavailableError) throw secretsRefusal(err)
    throw err
  }
  const { SecretRedactor } = await import('@vostride/agent-qa-runner')
  return {
    secretStore,
    secretRedactor: new SecretRedactor(secretStore),
    secretsFileMetadata: {
      path: secretsPath,
      status: 'loaded',
      count: secretStore.count(),
    },
  }
}

/**
 * RUNX-06, as a refusal a door can CALL.
 *
 * `filtered` is `parseAllTestBindings`' bindings verbatim — no grep narrows it — so an empty one
 * means discovery RESOLVED at least one test file (the "no files found" refusal already proved
 * that) and parsing produced ZERO runnable tests. Starting a run from there would assemble a
 * zero-member `RunSession` and render a benign-looking "Tests: 0 of 0 passed" summary: a silent
 * green non-run. An existing resolved target must FAIL LOUDLY instead, on the same config/usage
 * contract as the discovery refusals (T-365-04b).
 *
 * It became a throw for the reason every other preflight refusal did: this guard is now on a path
 * a daemon calls, and a daemon that exits 2 because somebody committed an empty test file is the
 * failure T-401-31 names.
 */
export function refuseZeroRunnableTests(
  files: readonly string[],
  bindings: readonly ParsedTestBinding[],
): void {
  if (bindings.length > 0) return
  throw new CliRunInputError(
    [
      pc.red('Error: Resolved test file(s) but found 0 runnable tests.'),
      ...files.map((file) => pc.red(`  ${file}`)),
      pc.dim('Each test file must define at least one test (a top-level `name` + `steps`, or a `tests:` list).'),
    ],
    2,
  )
}

/**
 * Reporter selection, as a refusal rather than an exit.
 *
 * The selection itself is argv vocabulary and stays a door concern — a programmatic door supplies
 * its own subscribers and never reaches this. What changed is the failure shape: the refusal is a
 * value the caller decides about, so no module on this path terminates its host.
 */
export function requireReporterSelection(opts: RunOptions): ReporterSelection {
  const result = resolveReporterSelection(opts)
  if (result.error) {
    throw new CliRunInputError([pc.red(`Error: ${result.error}`)], 2)
  }
  return result.selection!
}

/** What a door asks the input preflight for. Every field is something only a door knows. */
export interface RunInvocationInputRequest {
  /** `--config` on the CLI, `request.configPath` on a programmatic door. */
  readonly configPath?: string
  /** The operands. EMPTY means the configured default set, which is a live contract. */
  readonly patterns?: readonly string[]
  /** `--test` / `--suite` / `--all`. Absent is the default: tests via `workspace.testMatch`. */
  readonly mode?: 'test' | 'suite' | 'all'
  /** Config overrides a flag expressed (`--browser`). */
  readonly flagOverrides?: Record<string, unknown>
  /** `--dry-run`/`--list-tests` resolve config without loading auth plugins. */
  readonly loadAuthPlugins?: boolean
  /** The door's own resolved log level; the config's own setting is the fallback. */
  readonly logLevel?: string
  /** `--var KEY=VALUE`, repeatable. */
  readonly varFlags?: readonly string[]
  /** `--run-attr KEY=VALUE`, repeatable. */
  readonly runAttrFlags?: readonly string[]
  /** Where a non-fatal preflight warning goes. The door owns its rendering. */
  readonly warn?: (message: string) => void
}

/** Everything the run path needs before it can produce a member, and nothing it does not. */
export interface RunInvocationInputs {
  readonly config: AgentQaConfig
  readonly configFilePath: string
  readonly configDir: string
  readonly workspacePaths: ResolvedWorkspacePaths
  readonly configContent: string
  readonly runtimeSecrets: RuntimeSecretsContext
  readonly envFileVars: Record<string, string>
  readonly rawEnvFileContent: string | null
  readonly resolvedEnvFilePath: string | null
  readonly resolvedHooks: Map<string, HookDefinition>
  readonly sandboxOptions: SandboxRunnerOptions
  readonly effectiveLogLevel: string
  readonly cliVars: Record<string, string>
  readonly inlineVars: Record<string, string>
  readonly userRunAttributes: RunAttributes
  /**
   * BOTH HALVES OF THE DISCOVERY SPLIT, untouched.
   *
   * `discoverFilesForCliPatterns` already answers `{ tests, suites }` and the command already
   * captured both. Collapsing the split here would make the mode-aware member dispatch unbuildable:
   * a request carries patterns and NO mode flag (that is exactly what `runInProcessCliRun`
   * forwards, and what the child port 401-10 deleted forwarded before it), so the only thing that
   * can tell a suite invocation from a test invocation is which half of this pair came back
   * non-empty.
   */
  readonly discovered: { readonly tests: string[]; readonly suites: string[] }
  /**
   * The config is resolved plugin-free; this loads its auth and provider plugins once, after the
   * run's request and id are allowed and its record is open. A no-op for `loadAuthPlugins: false`.
   */
  readonly loadPlugins: () => Promise<void>
}

/**
 * THE INPUT PREFLIGHT, as a producer a door can CALL rather than a block a command performs.
 *
 * This is a verbatim lift of `agent-qa run`'s own preflight — same reads, same order, same rendered
 * strings — with one change: every failure that used to render and call `process.exit` now throws a
 * `CliRunInputError` carrying those same rendered lines and that same exit code. The command prints
 * `lines` and terminates with `exitCode`, so its observable behaviour is unchanged to the byte;
 * every other door gets a typed refusal instead of a dead host.
 *
 * IT STAYS IN THIS FILE, and that is the surface firewall's answer rather than a preference. The
 * preflight needs `@vostride/agent-qa-core`'s parser, workspace walker and env reader plus the two
 * private helpers below it; `commands/run.ts` is the only cli file ledgered for those packages, the
 * ledger only ever shrinks, and a file written after 2026-07-28 can never join it. What moved into
 * `composition/in-process-run-execution.ts` is the COMPOSITION; the vocabulary stays here.
 */
export async function resolveRunInvocationInputs(
  request: RunInvocationInputRequest = {},
): Promise<RunInvocationInputs> {
  const warn = request.warn
    ?? ((message: string) => { printRunText(message, (text) => console.warn(text)) })

  const config = await resolveConfig({
    configPath: request.configPath,
    flags: request.flagOverrides ?? {},
    loadAuthPlugins: false,
  })

  // Read raw config file content for cache key scoping
  const configFilePath = resolvePath(request.configPath ?? 'agent-qa.config.yaml')
  let pluginsLoaded: Promise<void> | undefined
  const loadPlugins = request.loadAuthPlugins === false
    ? async (): Promise<void> => {}
    : (): Promise<void> => (pluginsLoaded ??= loadConfigPlugins(config, configFilePath))
  const workspacePaths = resolveWorkspacePaths({ config, configPath: configFilePath })
  let configContent = ''
  try {
    const { readFile: readConfigFile } = await import('node:fs/promises')
    configContent = await readConfigFile(configFilePath, 'utf-8')
  } catch { /* best-effort: resolveConfig already required the file */ }

  // Load variables from env file, config inline, and CLI flags
  const { parseEnvFile } = await import('@vostride/agent-qa-core')
  const { readFileSync, existsSync } = await import('node:fs')
  const configDir = workspacePaths.configDir

  const cliVars = parseVarFlags(request.varFlags === undefined ? undefined : [...request.varFlags])
  let userRunAttributes: RunAttributes
  try {
    const parsedRunAttrs = parseRunAttrFlags(
      request.runAttrFlags === undefined ? undefined : [...request.runAttrFlags],
    )
    userRunAttributes = parsedRunAttrs.attributes
    for (const duplicateKey of parsedRunAttrs.duplicateKeys) {
      warn(`Warning: duplicate --run-attr key "${duplicateKey}"; using last value`)
    }
  } catch (err) {
    throw new CliRunInputError(
      [pc.red(`Error: ${err instanceof Error ? err.message : String(err)}`)],
      2,
    )
  }
  const inlineVars: Record<string, string> = {}

  const runtimeSecrets = await loadRuntimeSecrets({
    config,
    configDir,
    secretsFilePath: workspacePaths.secretsFile.absolutePath,
  })

  let envFileVars: Record<string, string> = {}
  let rawEnvFileContent: string | null = null
  const resolvedEnvFilePath: string | null = workspacePaths.envFile.absolutePath
  if (!existsSync(workspacePaths.envFile.absolutePath)) {
    throw new CliRunInputError(
      [pc.red(`Error: Env file not found: ${workspacePaths.envFile.absolutePath}`)],
      1,
    )
  }
  try {
    rawEnvFileContent = readFileSync(workspacePaths.envFile.absolutePath, 'utf-8')
    envFileVars = parseEnvFile(rawEnvFileContent)
  } catch {
    throw new CliRunInputError(
      [pc.red(`Error: Env file could not be read: ${workspacePaths.envFile.absolutePath}`)],
      1,
    )
  }

  let resolvedHooks: Map<string, HookDefinition>
  let sandboxOptions: SandboxRunnerOptions

  const hooksFilePath = workspacePaths.hooksFile.absolutePath
  if (!existsSync(hooksFilePath)) {
    throw new CliRunInputError([pc.red(`Error: Hooks file not found: ${hooksFilePath}`)], 1)
  }
  try {
    const { parseHooksFile } = await import('@vostride/agent-qa-core')
    const { hooks, errors } = await parseHooksFile(hooksFilePath)
    if (errors.length > 0) {
      throw new CliRunInputError(
        [
          pc.red('Hooks configuration errors:'),
          ...errors.map((err: string) => pc.red(`  - ${err}`)),
        ],
        1,
      )
    }
    resolvedHooks = new Map(hooks.map((h: HookDefinition) => [h.id, h]))
    // One Docker hook executor for the run, carried to every hook site in sandboxOptions.
    sandboxOptions = {
      executor: new DockerHookExecutor({ version: getAgentQaVersion() }),
      secretStore: runtimeSecrets.secretStore,
      secretRedactor: runtimeSecrets.secretRedactor,
    }
  } catch (err: any) {
    // THE RE-THROW IS LOAD-BEARING, not defensive. The hooks-error branch above used to be a
    // `process.exit(1)`, which never returns and therefore never reached this catch. Now that it is
    // a throw, an unguarded catch would swallow the specific "Hooks configuration errors:" report
    // and replace it with the generic "could not be read" one — a silent downgrade of a diagnostic,
    // introduced by the conversion itself.
    if (err instanceof CliRunInputError) throw err
    throw new CliRunInputError(
      [
        pc.red(`Error: Hooks file could not be read: ${hooksFilePath}`),
        ...(err instanceof Error && err.message ? [pc.dim(err.message)] : []),
      ],
      1,
    )
  }

  // Workspace agent-rules loading removed in Phase 373; policy serving
  // returns via Reader L0 policies in Phase 380.

  // Resolve effective log level: the door's own fold (CLI flag > --verbose/--quiet) > config > fallback
  const effectiveLogLevel = request.logLevel
    ?? (config as any).services?.logging?.level
    ?? 'warn'

  let discoveredTestFiles: string[] = []
  let discoveredSuiteFiles: string[] = []
  const patterns = [...(request.patterns ?? [])]

  if (patterns.length > 0) {
    try {
      const selected = await discoverFilesForCliPatterns(workspacePaths, patterns)
      discoveredTestFiles = selected.tests
      discoveredSuiteFiles = selected.suites
    } catch (err) {
      throw new CliRunInputError(
        [pc.red(`Error: ${err instanceof Error ? err.message : String(err)}`)],
        1,
      )
    }

    if (discoveredTestFiles.length === 0 && discoveredSuiteFiles.length === 0) {
      const patternKind = patterns.every((pattern) => classifyRunPattern(pattern) === 'suite') ? 'suite' : 'test'
      throw new CliRunInputError(
        [
          pc.red(`Error: No ${patternKind} files found matching patterns:`),
          ...patterns.map((p) => pc.red(`  ${p}`)),
        ],
        2,
      )
    }
  } else if (request.mode === 'suite') {
    discoveredSuiteFiles = (await discoverWorkspaceFiles({ workspace: workspacePaths, kind: 'suite' }))
      .map(record => record.absolutePath)
    if (discoveredSuiteFiles.length === 0) {
      throw new CliRunInputError(
        [
          pc.red('Error: No suite files found matching workspace.suiteMatch'),
          ...workspacePaths.suiteMatch.map((p) => pc.red(`  ${p}`)),
        ],
        2,
      )
    }
  } else if (request.mode === 'all') {
    discoveredTestFiles = (await discoverWorkspaceFiles({ workspace: workspacePaths, kind: 'test' }))
      .map(record => record.absolutePath)
    discoveredSuiteFiles = (await discoverWorkspaceFiles({ workspace: workspacePaths, kind: 'suite' }))
      .map(record => record.absolutePath)

    if (discoveredTestFiles.length === 0 && discoveredSuiteFiles.length === 0) {
      throw new CliRunInputError(
        [pc.red('Error: No test or suite files found. Check workspace.testMatch and workspace.suiteMatch in agent-qa.config.yaml')],
        2,
      )
    }
  } else {
    if (!workspacePaths.testMatch || workspacePaths.testMatch.length === 0) {
      throw new CliRunInputError(
        [pc.red('Error: No testMatch patterns in config. Add workspace.testMatch to agent-qa.config.yaml.')],
        2,
      )
    }
    discoveredTestFiles = (await discoverWorkspaceFiles({ workspace: workspacePaths, kind: 'test' }))
      .map(record => record.absolutePath)
    if (discoveredTestFiles.length === 0) {
      throw new CliRunInputError(
        [
          pc.red('Error: No test files found matching workspace.testMatch'),
          ...workspacePaths.testMatch.map((p) => pc.red(`  ${p}`)),
        ],
        2,
      )
    }
  }

  return {
    config,
    configFilePath,
    configDir,
    workspacePaths,
    configContent,
    runtimeSecrets,
    envFileVars,
    rawEnvFileContent,
    resolvedEnvFilePath,
    resolvedHooks,
    sandboxOptions,
    effectiveLogLevel,
    cliVars,
    inlineVars,
    userRunAttributes,
    discovered: { tests: discoveredTestFiles, suites: discoveredSuiteFiles },
    loadPlugins,
  }
}

// `kind` is narrowed from the full `RunArtifactKind` breadth to the one
// value this process can still produce. The parent/child kinds are RETAINED on the schema union
// (existing artifact documents carry them) but nothing mints them any more, so a parameter that
// still admitted them would be an affordance with no caller.
function buildRunArtifactContext(input: {
  kind: 'test'
  configContent: string
  parsedConfig: unknown
  effectiveConfig: unknown
  envFilePath: string | null
  rawEnvFileContent: string | null
  envFileVars: Record<string, string>
  secretsFileMetadata?: SecretsFileArtifactMetadata | null
  cliVars: Record<string, string>
  inlineVars: Record<string, string>
  hooks?: Map<string, HookDefinition>
  planner: { provider?: string; model?: string }
  verifier: { provider?: string; model?: string }
  platform: 'web' | 'android' | 'ios'
  target: ResolvedTarget
  deviceName?: string
  attributes: RunAttributes
  timeouts: Record<string, unknown>
  cache: Record<string, unknown>
  source: Record<string, unknown>
  secretRedactor?: SecretRedactorPort
}): { artifact: Record<string, unknown> & { kind: 'test' } } {
  return redactSecretValue({
    artifact: {
      kind: input.kind,
      config: {
        rawConfigContent: input.configContent,
        parsedConfig: input.parsedConfig,
        effectiveConfig: input.effectiveConfig,
        envFile: {
          path: input.envFilePath,
          content: input.rawEnvFileContent,
          variables: input.envFileVars,
        },
        secretsFile: input.secretsFileMetadata ?? null,
        cliVars: input.cliVars,
        inlineVars: input.inlineVars,
        hooks: buildHooksArtifact(input.hooks),
        model: {
          planner: input.planner,
          verifier: input.verifier,
        },
        runtime: {
          platform: input.platform,
          targetName: input.target.name,
          deviceName: input.deviceName,
        },
        timeouts: input.timeouts,
        cache: input.cache,
      },
      source: input.source,
      metadata: {
        attributes: input.attributes,
      },
    },
  }) as { artifact: Record<string, unknown> & { kind: 'test' } }
}

function wrapMobileSetupError(err: unknown): never {
  if (err instanceof MobileSetupError) {
    throw new Error(`${err.category}: ${err.message}`)
  }
  throw err
}

function resolveMobileRunOrThrow(input: Parameters<typeof resolveMobileRunConfig>[0]): ResolvedMobileRunConfig {
  try {
    return resolveMobileRunConfig(input)
  } catch (err) {
    wrapMobileSetupError(err)
  }
}

function getSelectedAuthStateUse(use: Record<string, unknown> | undefined): NormalizedAuthStateUse | undefined {
  return normalizeAuthStateUse(use)
}

async function resolveSelectedAuthStateForRun(input: {
  config: AgentQaConfig
  configDir: string
  resolvedTarget: ResolvedTarget
  authState: NormalizedAuthStateUse | undefined
}): Promise<ResolvedAuthStateForRun | undefined> {
  if (!input.authState || input.authState.load === false) return undefined
  try {
    return await resolveAuthStateForRun({
      configDir: input.configDir,
      authStateDir: input.config.services?.authState?.dir,
      targetName: input.resolvedTarget.name,
      stateName: input.authState.name,
      target: { platform: input.resolvedTarget.platform },
    })
  } catch (err) {
    // a config refusal, not a dead host. Found by the task-4 census's TRANSITIVE route-2
    // scan — this helper is two calls from the in-process path (`produceDirectRunMembers` → the
    // member closure → here), so a daemon serving a run whose auth-state config is wrong would have
    // exited on it. A scan that stopped at the exported bodies would have called the path clean.
    throw new CliRunInputError(
      [pc.red(`Error: ${err instanceof Error ? err.message : String(err)}`)],
      2,
    )
  }
}

function resolveAuthStateCapturePathsForRun(input: {
  config: AgentQaConfig
  configDir: string
  resolvedTarget: ResolvedTarget
  authState: NormalizedAuthStateUse | undefined
}): ResolvedAuthStatePaths | undefined {
  if (input.authState?.capture !== true) return undefined
  try {
    return resolveAuthStatePaths({
      configDir: input.configDir,
      authStateDir: input.config.services?.authState?.dir,
      targetName: input.resolvedTarget.name,
      stateName: input.authState.name,
      target: { platform: input.resolvedTarget.platform },
    })
  } catch (err) {
    // Same class, same finding, same fix as its sibling above.
    throw new CliRunInputError(
      [pc.red(`Error: ${err instanceof Error ? err.message : String(err)}`)],
      2,
    )
  }
}

function formatAuthStateCaptureFailure(paths: ResolvedAuthStatePaths): string {
  return `Could not save auth state "${paths.stateName}" for target "${paths.targetName}".`
}

function getStorageStateContext(adapter: PlatformAdapter): { storageState: (options?: { indexedDB?: boolean }) => Promise<unknown> } | null {
  const maybeGetPage = (adapter as { getPage?: () => unknown }).getPage
  if (typeof maybeGetPage !== 'function') return null

  const page = maybeGetPage.call(adapter)
  if (!page || typeof page !== 'object') return null

  const maybeContext = (page as { context?: () => unknown }).context
  if (typeof maybeContext !== 'function') return null

  const context = maybeContext.call(page)
  if (!context || typeof context !== 'object') return null

  const storageState = (context as { storageState?: (options?: { indexedDB?: boolean }) => Promise<unknown> }).storageState
  if (typeof storageState !== 'function') return null

  return {
    storageState: storageState.bind(context),
  }
}

async function captureAuthStateForRun(input: {
  adapter: PlatformAdapter
  paths: ResolvedAuthStatePaths
}): Promise<ResolvedAuthStateForRun> {
  const context = getStorageStateContext(input.adapter)
  if (!context) {
    throw new Error('Web auth-state capture requires a Playwright browser context.')
  }

  const payload = await context.storageState({ indexedDB: true })
  const capturedAt = new Date().toISOString()
  const metadata: AuthStateMetadata = {
    version: AUTH_STATE_SCHEMA_VERSION,
    kind: 'web' as const,
    target: input.paths.targetName,
    name: input.paths.stateName,
    capturedAt,
  }
  const { writeAuthStateFiles } = await import('@vostride/agent-qa-core')
  await writeAuthStateFiles(input.paths, { payload, metadata })

  return {
    version: metadata.version,
    kind: metadata.kind,
    targetName: metadata.target,
    stateName: metadata.name,
    capturedAt: metadata.capturedAt,
    storageStatePath: input.paths.payloadPath,
  }
}

async function executeSuites(
  suiteFiles: string[],
  opts: RunOptions,
  config: AgentQaConfig,
  globalOpts: { config?: string; verbose?: boolean; quiet?: boolean; logLevel?: string },
  configContent: string,
  effectiveLogLevel: string,
  variableContext: {
    envFileVars: Record<string, string>
    inlineVars: Record<string, string>
    cliVars: Record<string, string>
    rawEnvFileContent?: string | null
    resolvedEnvFilePath?: string | null
    secretStore?: SecretStore
    secretRedactor?: SecretRedactor
    secretsFileMetadata?: SecretsFileArtifactMetadata | null
    userRunAttributes: RunAttributes
  } | undefined,
  hooksContext: { resolvedHooks: Map<string, HookDefinition>; sandboxOptions: SandboxRunnerOptions } | undefined,
  // the invocation's analytics, composed ONCE at the command root and handed down. It is a
  // memoised resolver rather than a value for the reason `--list` and `--dry-run` exist: composing
  // resolves the identity store, and a command that never starts a run should not mint one. The
  // memo is what keeps "lazily" from becoming "twice".
  analytics: (() => Promise<CliAnalyticsHost>) | undefined,
  loadPlugins: () => Promise<void>,
): Promise<number> {
  const { parseSuiteFile, parseTestFile, patchTestForSuite } = await import('@vostride/agent-qa-core')
  // `startRun` is NOT among these. BOTH of this command's paths reach it through
  // `createRunInvocationCore`, and a binding held here would be a second way in.
  const { LLMPlanner, LLMVerifier, mapVerdictToExitCode } = await import('@vostride/agent-qa-runner')
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')

  const configFilePath = globalOpts.config ?? 'agent-qa.config.yaml'
  const configDir = path.dirname(path.resolve(configFilePath))

  // the read-only preflight is its own exported producer now — `--dry-run` stops on it,
  // and a programmatic door reaches the same parse without reaching this command.
  const preflight = await resolveSuitePreflight({ suiteFiles, config, configDir })

  // --dry-run RESOLVES AND REPORTS, THEN STOPS — and it stops HERE (401-04, RESEARCH Open Q2's
  // ratified disposition under D-02). `--dry-run` is not a kind of run; it is the answer to "what
  // WOULD this invocation execute", so it must not reach the gate: a run that will never happen has
  // no authorization question to ask, and an audit row for it would be a record of a decision about
  // nothing. Everything above this line is the read-only preflight (parse + product identity) the
  // comment there already names as running before signal registration, dashboard creation, adapter
  // setup, ordinal allocation or a run can mutate state — so stopping on this line reports off
  // fully resolved suites while nothing outside this process has been touched.
  //
  // THIS IS A BEHAVIOUR FIX, NOT A MIGRATION SIDE EFFECT. Until 401-04 the suite path had no
  // `--dry-run` handling at all (only the single-test path did, at its own `opts.dryRun` guard), so
  // `agent-qa run --dry-run <suite>` EXECUTED THE SUITE: measured on the pre-migration binary as a
  // real run with a baseline probe at the target, an advanced build ordinal, a full event log and a
  // handoff. A flag whose whole promise is "without executing" cannot keep that promise on one of
  // its command's two paths.
  if (opts.dryRun === true) {
    const suiteMemberCount = suiteFiles.reduce(
      (total, suiteFile) => total + (preflight.definitions.get(suiteFile)?.tests.length ?? 0),
      0,
    )
    console.log(pc.bold(`\nFound ${suiteFiles.length} suite(s), ${suiteMemberCount} test(s):\n`))
    const listing: string[] = []
    for (const suiteFile of suiteFiles) {
      const suite = preflight.definitions.get(suiteFile)
      if (suite === undefined) continue
      listing.push(`  ${pc.green('●')} ${suite.name}`)
      for (const member of suite.tests) {
        listing.push(`      ${member.test}`)
      }
    }
    if (listing.length > 0) printRunText(listing.join('\n'), (text) => console.log(text))
    return 0
  }

  let shutdownRequested = false
  let frozenExitCode: number | undefined
  // the CLI owns the ONE run-level SIGINT. When a RunSession is live the
  // handler routes the abort into `session.cancel()` (skip the rest, aggregate `cancelled`); core's
  // per-test SIGINT registration is suppressed because the executor threads ctx.abortSignal.
  let activeRunSession: { cancel(): void } | undefined
  const curationAbortController = new AbortController()
  // SESSION-04 force-exit backstop (Plan 361-13 Task 3): armed on cancel, cleared after
  // `await session.done`. Fires only if `done` is genuinely un-settleable so the CLI can never hang.
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  const clearGraceTimer = (): void => {
    if (graceTimer) clearTimeout(graceTimer)
    graceTimer = undefined
  }

  // one record per invocation, written whatever the config holds.
  const record = createRunRecord({
    attributes: buildCliRunAttributes(variableContext?.userRunAttributes ?? {}, 'local'),
    warn: (line) => printRunText(pc.yellow(line), (text) => console.warn(text)),
  })
  const forceExit = (code: number): never => {
    closeOwnRowAtForcedExit(record)
    process.exit(code)
  }

  // RUNX-02 / D1: route both signals through the controller so a SECOND Ctrl+C HARD force-exits
  // (130) immediately, independent of the grace timer and of any wedged async `done`. The grace-timer
  // arming/unref/clear stays inline here (owned by the caller) so the 361-13 backstop anchors hold.
  const shutdownController = createShutdownController({
    cancel: () => {
      curationAbortController.abort()
      try { activeRunSession?.cancel() } catch { /* cancel is best-effort */ }
    },
    exit: forceExit,
    setExitCode: (code) => { shutdownRequested = true; process.exitCode = frozenExitCode ?? code },
    armGrace: () => {
      if (frozenExitCode !== undefined) return
      const grace = setTimeout(() => forceExit(130), cancelGraceMs())
      grace.unref?.()
      graceTimer = grace
    },
  })

  // `on`, not `once`, so a repeated Ctrl+C reaches the controller's hard force-exit path.
  process.on('SIGINT', shutdownController.handleSignal)
  process.on('SIGTERM', shutdownController.handleSignal)
  process.on('SIGHUP', shutdownController.handleSignal)


  // the suite half's members and executor come from the ONE producer that owns
  // that chain — the SAME function a door holding nothing but a `RunsStartInput` with a suite
  // pattern reaches through `produceMembersFromPatterns`. `executeSuites` drives it; it no longer
  // is it.
  const runId = process.env.AGENT_QA_RUN_ID ?? generateRunId()
  const executionContext = resolveRunExecutionContext()
  let exitCode: number
  try {
    const reporterSelection = requireReporterSelection(opts)
    const produced = await produceSuiteRunMembers({
      suiteFiles,
      preflight,
      config,
      configDir,
      configFilePath,
      configContent,
      effectiveLogLevel,
      runId,
      opts,
      loadPlugins,
      runRecord: record,
      terminal: RUN_TERMINAL,
      hostOwnsSignals: true,
      ...(variableContext === undefined ? {} : { variableContext }),
      ...(hooksContext === undefined ? {} : { hooksContext }),
      ...(analytics === undefined ? {} : { analytics }),
    })
    printPlannerLimits(produced.plannerLimits)
    const members = produced.members
    const executor = produced.executor
    const runProduct = produced.product
    const buildTag = produced.buildTag
    const knowledgeRoot = produced.knowledgeRoot
    const runDigests = { runLevel: produced.configDigests }
    let suiteQuarantined: readonly QuarantineAppliedEntry[] = []

    // the run-level bus subscribers (Pitfall 8 — the SAME attach helper both of this door's
    // paths use). Analytics rides the bus; the drive attaches the record.
    const extraSubscribers: RunSubscriberHandle[] = []
    // the re-homed subscriber over the port this command composed at its root.
    // `config` is NOT passed — the opt-out posture is already expressed by which transport that port
    // holds, and a subscriber that re-read it would be the second decision site D-19 abolished.
    const analyticsHost = analytics === undefined ? undefined : await analytics()
    if (analyticsHost !== undefined) {
      extraSubscribers.push(buildAnalyticsRunSubscriber({
        analytics: analyticsHost,
        ...analyticsRunAttribution(
          buildCliRunAttributes(variableContext?.userRunAttributes ?? {}, 'local'),
        ),
      }))
    }

    // NOTHING ASKS. This door builds no confirm channel and carries no session trust: a suite starts
    // at a terminal, on a piped stdio and in CI alike, whatever environment its targets declare.

    // THE SUITE PATH IS A CALLER OF THE SAME ONE IN-PROCESS DRIVE the single-test
    // path calls. With this, `createRunInvocationCore` is composed in exactly ONE place in the whole
    // CLI door, and the two near-identical post-`done` bodies became one.
    const { runInProcessCliRun } = await import('../composition/in-process-run-execution.js')

    const outcome = await (runInProcessCliRun as typeof RunInProcessCliRun)(
      {
        configPath: configFilePath,
        agentQaRoot: resolvePath(configDir, '.agent-qa'),
        executionContext,
        // The members this door already produced — the SAME suite factory the default dispatcher
        // reaches for a suite pattern, handed over rather than re-run.
        produceMembers: async () => produced,
        // what the shell's post-verdict step should do about POST-PROCESSING for this
        // run. `--detach` asks this process not to SPEND itself on the chain, so it skips the LEASE —
        // never the enqueue, which the step performs either way (RESEARCH Pitfall 8). The literal-only
        // spread is the same house rule the INVK-06 markers ride: an absent flag is an ABSENT field.
        postProcessing: { ...(opts.detach === true ? { detach: true as const } : {}) },
        runRecord: record,
        onSession: (session) => {
          activeRunSession = session
        },
        subscribers: ({ session, quarantined, mask }) => {
          analyticsHost?.bindMaskingContext({ mask })
          return attachRunSubscribers({
            session,
            console: reporterSelection.console ? { verbose: false, logLevel: effectiveLogLevel } : false,
            junitOutputPath: reporterSelection.junit ? opts.junitOutput : undefined,
            extraSubscribers,
            // the SAME resolved set the run was assembled with, so the reporters and the
            // aggregate verdict rule describe one disposition rather than two.
            quarantined,
          })
        },
        warn: (message) =>
          printRunText(pc.yellow(`  Quarantine: ${message}`), (text) => console.warn(text)),
        postVerdictSignal: curationAbortController.signal,
        freezeVerdict: (verdict) => {
          clearGraceTimer()
          activeRunSession = undefined
          frozenExitCode = mapVerdictToExitCode(
            shutdownRequested ? 'cancelled' : (verdict as never),
          )
          return frozenExitCode
        },
        afterVerdict: async ({ exitCode: verdictExitCode, mask, postVerdict, postVerdictDeadlineMs }) => {
          // ONE shared post-run tail serves both of this command's tail sites
          // (Pitfall 1). 404 D-05: the ENQUEUE is no longer one of its legs — the shell's
          // post-verdict step performed it before `runFinished`, on this door and on every other,
          // and it ran under `--detach` too (Pitfall 8). What is detach-gated is the in-process
          // chain drain, and neither leg can replace the code frozen on the line above.
          const postRunTail = composeCliPostRunTail({
            postVerdict,
            ...(postVerdictDeadlineMs === undefined ? {} : { deadlineMs: postVerdictDeadlineMs }),
            runId,
            configDir,
            configFilePath,
            knowledgeConfig: config.knowledge,
            mask,
            ...(produced.getCurationModelDeps() === undefined
              ? {}
              : { modelDeps: produced.getCurationModelDeps()! }),
            signal: curationAbortController.signal,
            log: curationTailLog,
            executionContext,
          })
          return await runVerdictFirstCurationTail({
            exitCode: verdictExitCode,
            detach: opts.detach === true,
            // pump under the lease the shell's post-verdict step decided on. Routing
            // it here rather than letting `drain()` consult for itself is what keeps acquire ->
            // pump -> release one lease; a second consult would answer `held` by this very
            // process and hand the chain off to nobody (RESEARCH Pitfall 3).
            //
            // HANDED AS A THUNK, NOT AS A VALUE. Taking the authority is what
            // acquires it, and evaluating the take as the ARGUMENT acquired it before `drain()`
            // was even entered — where a composition failure could then return past the release
            // and past the step's own no-leak backstop, leaving the fence held for its TTL. The
            // pump calls this when it is ready to hold a lease.
            runTail: () => postRunTail.drain({
              takeLease: () => postVerdict.takeAcquiredLease(),
            }),
            // the close-out line runs on BOTH paths, --detach included.
            finish: (input) => postRunTail.finish(input),
            onUnexpectedError: () => {
              curationTailLog.warn(unexpectedCurationTailWarning(executionContext))
            },
          })
        },
      },
      {
        // THE MARKERS RIDE THE REQUEST. `runMarkers` maps this command's two options onto
        // the two literal-`true` fields; request → RunConfig is the core's job, and there is no argv
        // link left inside the invocation.
        runId: asRunId(runId),
        ...runMarkers(opts),
      },
    )
    exitCode = outcome.exitCode
  } finally {
    clearGraceTimer()
    shutdownController.dispose()
    process.removeListener('SIGINT', shutdownController.handleSignal)
    process.removeListener('SIGTERM', shutdownController.handleSignal)
    process.removeListener('SIGHUP', shutdownController.handleSignal)
    record.close()
  }

  releaseAppium()
  return exitCode
}

/**
 * A parse refusal, which is an input refusal that carries its own diagnostics.
 *
 * SUBCLASSED RATHER THAN COLLAPSED because the CLI door does one thing more with a parse failure
 * than any other door does: it writes a `failed` run row and a run artifact carrying the errors.
 * That is REPORTING, which belongs to the door and not to the in-process path — a daemon or a chat
 * host sees an ordinary `CliRunInputError` and needs to know nothing about run rows.
 *
 * It extends the class from the LEAF module, never one re-exported through
 * `in-process-run-execution.js`: `extends` is evaluated while the module graph is still
 * initialising, and this file and that one import each other.
 */
export class CliRunParseError extends CliRunInputError {
  constructor(
    lines: readonly string[],
    readonly parseErrors: readonly ParseError[],
    readonly files: readonly string[],
  ) {
    super(lines, 2)
    this.name = 'CliRunParseError'
  }
}

/**
 * The id mint, published so the ONE in-process drive can hand it to the core.
 *
 * `mintRunId` is a REQUIRED core option: `agent-local` does not depend on the id package,
 * and an id shape invented there would be a second spelling of a run's identity. The drive lives in
 * `packages/cli/src/composition/`, which may not name `@vostride/agent-qa-core` either — so the mint
 * travels the same relative route every other producer here does.
 */
export const mintCliRunId = generateRunId

/**
 * The mint's inverse, published the same way and for the same reason.
 *
 * `isMintedRunId` is a REQUIRED core option with no default: an optional predicate with a
 * permissive fallback would be the accept-any-string defect wearing a type. It travels beside
 * `mintCliRunId` so the two are read together and cannot come to answer about different shapes —
 * an id this returns `false` for is one `mintCliRunId` could not have produced.
 *
 * THIS IS ALSO WHAT COVERS THE ENVIRONMENT DOOR. `AGENT_QA_RUN_ID` reaches a run id without ever
 * passing `RunsStartInputSchema` — the command builds the request literal in-process — so the
 * schema's path-safety refusal does not range it. The core's shape refusal does, because every
 * door composes the core.
 */
export const isMintedCliRunId = isCanonicalRunId

/** What the mode-aware default producer is handed. */
export interface PatternMemberProductionContext {
  readonly inputs: RunInvocationInputs
  readonly runId: string
  /** The run's record; the suite half opens it before it loads plugins or prepares a suite. */
  readonly runRecord?: RunRecord
  readonly opts?: RunOptions
  readonly analytics?: () => Promise<CliAnalyticsHost>
  /**
   * An Appium a HOST already leased for this run (401-07, D-01/D-12 — INVK-01 truth 5).
   *
   * Absent ⇒ the shipped behaviour: `AGENT_QA_APPIUM_URL`, then the bundled auto-start. Present ⇒
   * the host's URL wins, and this process manages nothing. See `AppiumUrlResolver`.
   */
  readonly resolveAppiumUrl?: AppiumUrlResolver
}

/**
 * THE MODE-AWARE DEFAULT MEMBER PRODUCER — the thing that makes the port composable from a bare
 * `RunsStartInput`.
 *
 * WHY IT DISPATCHES AND DOES NOT JUST ASSUME TEST FILES. A `runs.start` carries `patterns` and no
 * mode flag — the request contract cannot tell a test pattern from a suite pattern and does not try.
 * (Nor could the child port 401-10 deleted, which forwarded the same patterns after a `--` operand
 * separator.) So on the shipped wire a `runs.start` whose patterns resolve to suite files RUNS A
 * SUITE, over the fn door and the daemon door alike. A single-test-shaped default would turn that live
 * request into an input error at exactly the two doors this seam exists to unblock.
 *
 * THE POLARITY IS MIRRORED FROM THE COMMAND'S OWN GUARD, not restated from memory. `run.ts`'s
 * dispatch reads `if (discoveredSuiteFiles.length > 0 && discoveredTestFiles.length === 0)` — the
 * suite path is an EARLY RETURN taken only when discovery resolved no test files at all. So the
 * test half wins whenever it applies, and a producer that preferred suites whenever any suite
 * resolved would be a regression in the other direction (an `--all`-shaped invocation would stop
 * running its tests).
 *
 * ABSENT PATTERNS resolve the configured default set through the same split, which is the
 * argument-less `runs.start` edge.
 */
export async function produceMembersFromPatterns(
  context: PatternMemberProductionContext,
): Promise<ProducedCliRunMembers> {
  const { tests, suites } = context.inputs.discovered

  if (tests.length > 0) {
    const { parseAllTestBindings } = await import('@vostride/agent-qa-core')
    const parseResult = await parseAllTestBindings([...tests])
    if (parseResult.errors.length > 0) {
      throw new CliRunParseError(
        [
          pc.red(`Found ${parseResult.errors.length} parse error(s):`),
          '',
          ...formatParseErrorLines(parseResult.errors),
        ],
        parseResult.errors,
        [...tests],
      )
    }
    refuseZeroRunnableTests(tests, parseResult.bindings)
    const product = requireSingleInvocationProduct(
      parseResult.bindings.flatMap(({ test }) => {
        if (test.target === undefined) return []
        return [{
          label: `test ${test.name}`,
          product: resolveTarget(context.inputs.config, test.target).product,
        }]
      }),
    )
    return produceDirectRunMembers({
      inputs: context.inputs,
      bindings: parseResult.bindings,
      runId: context.runId,
      ...(product === undefined ? {} : { product }),
      ...(context.opts === undefined ? {} : { opts: context.opts }),
      ...(context.analytics === undefined ? {} : { analytics: context.analytics }),
      ...(context.resolveAppiumUrl === undefined ? {} : { resolveAppiumUrl: context.resolveAppiumUrl }),
    })
  }

  if (suites.length > 0) {
    const preflight = await resolveSuitePreflight({
      suiteFiles: suites,
      config: context.inputs.config,
      configDir: context.inputs.configDir,
    })
    return produceSuiteRunMembers({
      suiteFiles: suites,
      preflight,
      config: context.inputs.config,
      configDir: context.inputs.configDir,
      configFilePath: context.inputs.configFilePath,
      configContent: context.inputs.configContent,
      effectiveLogLevel: context.inputs.effectiveLogLevel,
      runId: context.runId,
      loadPlugins: context.inputs.loadPlugins,
      ...(context.runRecord === undefined ? {} : { runRecord: context.runRecord }),
      ...(context.opts === undefined ? {} : { opts: context.opts }),
      variableContext: {
        envFileVars: context.inputs.envFileVars,
        inlineVars: context.inputs.inlineVars,
        cliVars: context.inputs.cliVars,
        rawEnvFileContent: context.inputs.rawEnvFileContent,
        resolvedEnvFilePath: context.inputs.resolvedEnvFilePath,
        secretStore: context.inputs.runtimeSecrets.secretStore,
        secretRedactor: context.inputs.runtimeSecrets.secretRedactor,
        secretsFileMetadata: context.inputs.runtimeSecrets.secretsFileMetadata,
        userRunAttributes: context.inputs.userRunAttributes,
      },
      hooksContext: {
        resolvedHooks: context.inputs.resolvedHooks,
        sandboxOptions: context.inputs.sandboxOptions,
      },
      ...(context.analytics === undefined ? {} : { analytics: context.analytics }),
      ...(context.resolveAppiumUrl === undefined ? {} : { resolveAppiumUrl: context.resolveAppiumUrl }),
    })
  }

  // Defense in depth: `resolveRunInvocationInputs` already refuses an empty split, so reaching here
  // means a door produced its own inputs and produced nothing to run.
  throw new CliRunInputError([pc.red('Error: No test or suite files resolved for this run.')], 2)
}

/**
 * The read-only suite preflight: parse every suite and its members, and decide the invocation's
 * single product. Nothing here touches a target, a device, a database or a counter.
 *
 * IT IS ITS OWN FUNCTION because `--dry-run` stops on exactly this and goes no further (401-04's
 * ratified disposition of RESEARCH Open Q2): a run that will never happen has no authorization
 * question to ask, so it must not reach the gate — and it cannot report what it WOULD run without
 * having parsed it first.
 */
export interface SuitePreflight {
  readonly definitions: Map<string, SuiteDefinition>
  readonly preloadedTests: Map<string, PreloadedSuiteTest>
  readonly product: string | undefined
}

export type PreloadedSuiteTest = {
  fileContent: string
  parseResult: { tests: TestDefinition[]; errors: ParseError[] }
}

export async function resolveSuitePreflight(input: {
  readonly suiteFiles: readonly string[]
  readonly config: AgentQaConfig
  readonly configDir: string
}): Promise<SuitePreflight> {
  const { parseSuiteFile, parseTestFile } = await import('@vostride/agent-qa-core')
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')

  const definitions = new Map<string, SuiteDefinition>()
  const preloadedTests = new Map<string, PreloadedSuiteTest>()
  const suiteProductMembers: InvocationProductMember[] = []

  for (const suiteFile of input.suiteFiles) {
    const suite = await parseSuiteFile(suiteFile)
    definitions.set(suiteFile, suite)
    if (suite.target !== undefined) {
      suiteProductMembers.push({
        label: `suite ${suite.name}`,
        product: resolveTarget(input.config, suite.target).product,
      })
    }

    for (const member of suite.tests) {
      if (!isPathInsideDir(member.test, input.configDir)) continue
      const absolutePath = path.resolve(input.configDir, member.test)
      const fileContent = await readFile(absolutePath, 'utf-8')
      const parseResult = parseTestFile(fileContent, absolutePath)
      preloadedTests.set(absolutePath, { fileContent, parseResult })

      if (suite.target === undefined) {
        const test = parseResult.errors.length === 0 ? parseResult.tests[0] : undefined
        if (test?.target !== undefined) {
          suiteProductMembers.push({
            label: `suite ${suite.name} member ${test.name}`,
            product: resolveTarget(input.config, test.target).product,
          })
        }
      }
    }
  }

  return {
    definitions,
    preloadedTests,
    product: requireSingleInvocationProduct(suiteProductMembers),
  }
}

/**
 * THE SUITE-HALF MEMBER PRODUCER.
 *
 * The counterpart of `produceDirectRunMembers`, and it exists for the same reason: the chain that
 * turns a suite file into `assembleCliRun`'s required `members`/`executor` lived unexported inside
 * `executeSuites`, so no door holding a `RunsStartInput` could reach it. That is the wall 401-06
 * halted on, and it is why this half is extracted HERE rather than in a later plan: the default
 * member producer must be able to run a suite, because a `runs.start` carries patterns with NO mode
 * flag and a suite pattern therefore runs a suite over the fn and daemon doors TODAY. Leaving the suite chain unexported would have handed 401-05 the same wall.
 *
 * `executeSuites` is now a caller of this function, so the two are one implementation rather than a
 * copy and the thing it drives.
 *
 * WHAT IT DOES NOT DO, same as the test half: it does not resolve an execution context (the DOOR
 * does, D-07), it does not mint the run id, it does not build the audit sink or the safety hooks
 * (the drive does, once, and binds the hooks back), and it cannot terminate its host — the five
 * config-error refusals `prepareSuite` used to answer with `process.exit(2)` are `CliRunInputError`
 * throws carrying the same rendered lines and the same code.
 */
export interface SuiteRunMemberProductionInput {
  readonly suiteFiles: readonly string[]
  readonly preflight: SuitePreflight
  readonly config: AgentQaConfig
  readonly configDir: string
  readonly configFilePath: string
  readonly configContent: string
  readonly effectiveLogLevel: string
  /** The run's identity, minted by the door — a run's id is never a producer's to invent. */
  readonly runId: string
  readonly opts?: RunOptions
  readonly variableContext?: SuiteVariableContext
  readonly hooksContext?: { resolvedHooks: Map<string, HookDefinition>; sandboxOptions: SandboxRunnerOptions }
  readonly analytics?: () => Promise<CliAnalyticsHost>
  /**
   * An Appium a HOST already leased for this run (401-07, D-01/D-12 — INVK-01 truth 5).
   *
   * Absent ⇒ the shipped behaviour: `AGENT_QA_APPIUM_URL`, then the bundled auto-start. Present ⇒
   * the host's URL wins, and this process manages nothing. See `AppiumUrlResolver`.
   */
  readonly resolveAppiumUrl?: AppiumUrlResolver
  /** `RunInvocationInputs.loadPlugins`, awaited once the run's record is open. */
  readonly loadPlugins: () => Promise<void>
  /** The run's record, opened before this producer loads its plugins or prepares a suite. */
  readonly runRecord?: RunRecord
  readonly terminal?: RunTerminal
  // only agent-qa run passes this; its
  // controller owns SIGINT, SIGTERM and SIGHUP.
  readonly hostOwnsSignals?: true
}

export interface SuiteVariableContext {
  envFileVars: Record<string, string>
  inlineVars: Record<string, string>
  cliVars: Record<string, string>
  rawEnvFileContent?: string | null
  resolvedEnvFilePath?: string | null
  secretStore?: SecretStore
  secretRedactor?: SecretRedactor
  secretsFileMetadata?: SecretsFileArtifactMetadata | null
  userRunAttributes: RunAttributes
}

export async function produceSuiteRunMembers(
  input: SuiteRunMemberProductionInput,
): Promise<ProducedCliRunMembers> {
  const suiteFiles = [...input.suiteFiles]
  const hostSignals = input.hostOwnsSignals === true ? { hostOwnsSignals: true as const } : {}
  const config = input.config
  const configDir = input.configDir
  const configFilePath = input.configFilePath
  const configContent = input.configContent
  const effectiveLogLevel = input.effectiveLogLevel
  const runId = input.runId
  const opts: RunOptions = input.opts ?? ({} as RunOptions)
  const variableContext = input.variableContext
  const suiteRunSecretRedactor = variableContext?.secretRedactor
  if (suiteRunSecretRedactor === undefined) {
    throw new Error('This suite run has no secrets redactor; its records cannot be masked, so it was not started.')
  }
  const suiteRunMask: MaskFn = (text) => suiteRunSecretRedactor.redactString(text)
  const hooksContext = input.hooksContext
  const analytics = input.analytics
  const parsedSuiteDefinitions = input.preflight.definitions
  const preloadedSuiteTests = input.preflight.preloadedTests
  const suitePreflightProduct = input.preflight.product

  // Read before the run is recorded, so a refused local file refuses the run instead of failing it.
  const readLocalBindings = createRunLocalBindingsReader()
  const suiteTargetNames = [...parsedSuiteDefinitions.values()].map((suite) => suite.target)
  if (anyTargetRunsOnDevice(config, suiteTargetNames)) readLocalBindings()

  // The record opens here, before plugins; the drive's later open is a no-op.
  await input.runRecord?.open({
    runId,
    configDir,
    ...(config.services?.dashboard?.dbPath === undefined
      ? {}
      : { configuredDbPath: config.services.dashboard.dbPath }),
  })
  // Plugins load once the record is open, before any suite is prepared.
  await input.loadPlugins()

  const { parseTestFile, patchTestForSuite } = await import('@vostride/agent-qa-core')
  // `startRun` is NOT among these — every path reaches it through the invocation core.
  const { LLMPlanner, LLMVerifier } = await import('@vostride/agent-qa-runner')
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')

  let activeRunSession: { cancel(): void } | undefined
  void activeRunSession
  const suiteSnapshots = createRunArtifactSnapshotChannel()

  // a preparation failure is filed under this run's own id, once.
  const recordPreparationFailure = (row: {
    name: string
    failureSummary: string
    errorLog: string
    attributes: RunAttributes
  }): void => {
    const db = input.runRecord?.db
    if (db === undefined || db.getRun(runId) !== undefined) return
    const now = new Date().toISOString()
    db.insertRun({
      id: runId,
      name: row.name,
      status: 'failed',
      duration: 0,
      startedAt: now,
      endedAt: now,
      attributes: row.attributes,
      failureSummary: row.failureSummary,
    })
    db.updateRun(runId, { errorLog: row.errorLog })
  }

  // One resolved suite member. The two path legs are semantically opposite and both `string`, so
  // they are NAMED rather than positional: a reorder of the construction or the consumption is a
  // compile error instead of a silent CR-02 relapse (round-1 WR-06). `buildDirectRunMembers` gets
  // the same split right by construction.
  type SuiteTestEntry = {
    /** The parsed test definition this suite ref resolved to. */
    test: TestDefinition
    /** ABSOLUTE — every byte read (parse, upload resolution, artifacts) runs off this leg. */
    absolutePath: string
    /**
     * Workspace-relative durable IDENTITY: the descriptor, the handoff, the
     * projection and the committed quarantine ledger all key on this leg, so it must be the same
     * bytes on every checkout. A machine-local path here is exactly the CR-02 defect.
     */
    identityPath: string
  }

  // A suite fully resolved by the composition root, ready to contribute its members to the ONE
  // RunSession. Suite-level orchestration (setup hooks + adapter setup + nav / teardown +
  // auth capture + reporter end-calls) is captured as the lazy lifecycle `setup`/`teardown` the
  // shell drives when a member of this suite first runs / when the run crosses a suite boundary.
  type PreparedSuite = {
    suiteFile: string
    suite: SuiteDefinition
    suiteKey: string
    suiteConfig: RunSuiteConfig
    stepModelScope: StepModelScopeFactory
    modelProfiles: { planner: DeclaredModelProfile; verifier: DeclaredModelProfile }
    curationModelDeps: CurationTailModelDeps
    /**
     * Minted ONCE in `prepareSuite`, beside the resolve that produced `absolutePath`, so no consumer
     * downstream has to re-derive the identity (and none can derive it differently). The
     * absolute-vs-identity split the legs carry is documented on `SuiteTestEntry`'s own fields.
     */
    testEntries: SuiteTestEntry[]
    suiteMembers: Array<Record<string, unknown>>
    suiteRunId: string
    suiteArtifact: Record<string, unknown> | undefined
    product: string | undefined
    testFileContents: string[]
    // Mutable run-state filled during execution.
    suiteHookVars: Record<string, string>
    suiteSandboxOptions: RunSuiteConfig['sandboxOptions']
    results: TestResult[]
    perMemberDigests: ConfigDigests[]
    bootstrapFailure: string | undefined
    // Teardown-time composition side effects (the old runSuite `.finally`).
    suiteWorkingMemory: WorkingMemoryStore
    suiteAttributes: RunAttributes
    knowledgeSeed: {
      accounting: ReturnType<typeof createTokenAccounting>
      capabilities: ModelCapabilities
      qaRulesText: string
      workingContextText: string
      deferredNonActionTools?: NonActionToolMap
    }
    knowledge?: RunKnowledgeComposition
  }

  const prepareSuite = async (suiteFile: string, suite: SuiteDefinition): Promise<PreparedSuite> => {
    const suiteFailureAttributes = buildCliRunAttributes(
      variableContext?.userRunAttributes ?? {},
      'local',
    )
    let suiteFileContent = ''
    try { suiteFileContent = await readFile(suiteFile, 'utf-8') } catch { /* best-effort */ }

    const mergedUse = mergeUseBlocks(
      config.use as Record<string, unknown>,
      suite.use as Record<string, unknown> | undefined,
      undefined,
      {},
    )
    const suiteAuthStateUse = getSelectedAuthStateUse(mergedUse as Record<string, unknown>)

    const testEntries: SuiteTestEntry[] = []
    const suiteMembers: Array<Record<string, unknown>> = []
    for (const { test: relativePath, id: suiteEntryId } of suite.tests) {
      if (!isPathInsideDir(relativePath, configDir)) {
        const refusalLines = [pc.red(`Path traversal rejected: ${relativePath}`)]
        recordPreparationFailure({
          name: `Path traversal rejected in suite`,
          attributes: suiteFailureAttributes,
          failureSummary: `Path traversal rejected: ${relativePath}`,
          errorLog: `Path traversal rejected: ${relativePath}`,
        })
        input.terminal?.printRunId(runId)
        input.terminal?.printRunAttributes(suiteFailureAttributes)
        throw new CliRunInputError(refusalLines, 2)
      }

      const absolutePath = path.resolve(configDir, relativePath)
      const preloaded = preloadedSuiteTests.get(absolutePath)
      const fileContent = preloaded?.fileContent ?? await readFile(absolutePath, 'utf-8')
      const parseResult = preloaded?.parseResult ?? parseTestFile(fileContent, absolutePath)
      if (parseResult.errors.length > 0) {
        const refusalLines = [
          pc.red(`Parse errors in ${relativePath}:`),
          ...formatParseErrorLines(parseResult.errors),
        ]
        const errorLines: string[] = []
        for (const e of parseResult.errors) {
          const location = `${e.file}:${e.line}:${e.column}`
          errorLines.push(`${e.severity}: ${e.message}\n  --> ${location}`)
        }
        recordPreparationFailure({
          name: `Parse errors in suite "${suite.name}"`,
          attributes: suiteFailureAttributes,
          failureSummary: `${parseResult.errors.length} parse error(s) in ${relativePath}`,
          errorLog: errorLines.join('\n'),
        })
        input.terminal?.printRunId(runId)
        input.terminal?.printRunAttributes(suiteFailureAttributes)
        throw new CliRunInputError(refusalLines, 2)
      }
      if (parseResult.tests.length === 0) {
        const refusalLines = [pc.red(`No test definition found in ${relativePath}`)]
        recordPreparationFailure({
          name: `No test definition in suite "${suite.name}"`,
          attributes: suiteFailureAttributes,
          failureSummary: `No test definition found in ${relativePath}`,
          errorLog: `No test definition found in ${relativePath}`,
        })
        input.terminal?.printRunId(runId)
        input.terminal?.printRunAttributes(suiteFailureAttributes)
        throw new CliRunInputError(refusalLines, 2)
      }

      const testDef = parseResult.tests[0]
      const childAuthStateUse = getSelectedAuthStateUse(testDef.use as Record<string, unknown> | undefined)
      // The suite owns the shared browser context; child authState can only repeat the same logical state.
      if (suiteAuthStateUse && childAuthStateUse && childAuthStateUse.name !== suiteAuthStateUse.name) {
        throw new CliRunInputError(
          [pc.red(`Suite auth state "${suiteAuthStateUse.name}" conflicts with child test auth state "${childAuthStateUse.name}". Use one primary auth state per suite.`)],
          2,
        )
      }
      if (testDef['test-id'] && testDef['test-id'] !== suiteEntryId) {
        const mismatchMsg = `ID mismatch in suite "${suite.name}": test file ${relativePath} has test-id "${testDef['test-id']}" but suite entry specifies id "${suiteEntryId}"`
        const refusalLines = [pc.red(mismatchMsg)]
        recordPreparationFailure({
          name: `ID mismatch in suite "${suite.name}"`,
          attributes: suiteFailureAttributes,
          failureSummary: mismatchMsg,
          errorLog: mismatchMsg,
        })
        input.terminal?.printRunId(runId)
        input.terminal?.printRunAttributes(suiteFailureAttributes)
        throw new CliRunInputError(refusalLines, 2)
      }

      suiteMembers.push({
        index: suiteMembers.length,
        ref: { test: relativePath, id: suiteEntryId },
        filePath: absolutePath,
        testId: testDef['test-id'] ?? null,
        name: testDef.name,
        target: testDef.target ?? null,
        rawYaml: fileContent,
        resolvedDefinition: testDef,
        loadStatus: 'loaded',
      })
      // mint the durable identity HERE, beside the resolve that produced
      // `absolutePath`, through core's one exported recipe. `relativePath` is the suite ref as the
      // author typed it (it may carry a leading `./`), so it is deliberately NOT reused as identity
      // — the direct-run path has no such ref and would then mint different bytes for the same file.
      testEntries.push({
        test: testDef,
        absolutePath,
        identityPath: workspaceRelativeIdentityPath(configDir, absolutePath),
      })
    }

    const suiteResolvedTarget = suite.target
      ? resolveTarget(config, suite.target!)
      : resolveTarget(config, testEntries[0].test.target!)
    const suitePlatform: 'web' | 'android' | 'ios' = suiteResolvedTarget.platform

    const suiteAuthState = await resolveSelectedAuthStateForRun({
      config,
      configDir,
      resolvedTarget: suiteResolvedTarget,
      authState: suiteAuthStateUse,
    })
    const suiteAuthStateCapturePaths = resolveAuthStateCapturePathsForRun({
      config,
      configDir,
      resolvedTarget: suiteResolvedTarget,
      authState: suiteAuthStateUse,
    })
    const suiteEffectiveCacheEnabled = !opts.disableCache && (mergedUse as Record<string, unknown>).cache !== false
    let suiteDeviceName = opts.device ?? (mergedUse.device as string | undefined)

    if ((suitePlatform === 'android' || suitePlatform === 'ios') && !suiteDeviceName) {
      const childDeviceNames = testEntries.map(({ test: testDef }) => {
        const device = (testDef.use as Record<string, unknown> | undefined)?.device
        return typeof device === 'string' && device.trim().length > 0 ? device.trim() : undefined
      })
      const missingChildDevice = childDeviceNames.some((device) => !device)
      const uniqueChildDevices = [...new Set(childDeviceNames.filter((device): device is string => Boolean(device)))]

      if (missingChildDevice || uniqueChildDevices.length === 0) {
        throw new Error(`Select a device for this mobile suite "${suite.name}" with suite use.device or every child test use.device.`)
      }
      if (uniqueChildDevices.length > 1) {
        throw new Error(`Mobile suite child tests use multiple devices (${uniqueChildDevices.join(', ')}); set suite use.device or split the suite.`)
      }
      suiteDeviceName = uniqueChildDevices[0]
    }
    const deviceName = suiteDeviceName

    const suiteTimeoutConfig = mergedUse.timeout as Record<string, unknown> | undefined
    const testTimeouts = {
      step: typeof suiteTimeoutConfig?.step === 'number' ? suiteTimeoutConfig.step : 30000,
      test: typeof suiteTimeoutConfig?.test === 'number' ? suiteTimeoutConfig.test : 120000,
      navigation: typeof suiteTimeoutConfig?.navigation === 'number' ? suiteTimeoutConfig.navigation : DEFAULT_NAVIGATION_TIMEOUT_MS,
    }

    const suiteLocalBindings = suitePlatform === 'android' || suitePlatform === 'ios'
      ? readLocalBindings()
      : null
    let mobileResolved: ResolvedMobileRunConfig | undefined
    let resolvedDevice: ResolvedMobileDevice | undefined
    if (suitePlatform === 'android' || suitePlatform === 'ios') {
      mobileResolved = resolveMobileRunOrThrow({
        config: config as unknown as Record<string, any>,
        targetName: suiteResolvedTarget.name,
        platform: suitePlatform,
        explicitDeviceName: opts.device,
        useDeviceName: suiteDeviceName,
        appState: (mergedUse.mobile as Record<string, unknown> | undefined)?.appState as 'preserve' | 'reset' | undefined,
        localBindings: suiteLocalBindings,
        configFilePath: path.resolve(configFilePath),
        localConfigFilePath: suiteLocalBindings?.filePath,
        appiumUrl: resolveHostAppiumUrl(input.resolveAppiumUrl),
      })
      resolvedDevice = mobileResolved.device
    }

    const suiteAttributes = buildCliRunAttributes(variableContext?.userRunAttributes ?? {}, 'local')

    // Auto-start Appium for mobile platforms
    if (suitePlatform === 'ios' || suitePlatform === 'android') {
      try {
        const appiumUrl = await acquireAppium(effectiveLogLevel, input.resolveAppiumUrl)
        if (mobileResolved) {
          // `managed` means THIS process started the Appium it is talking to. A host-leased URL is
          // no more managed here than an env-supplied one — the dashboard owns that lifecycle.
          const provided = resolveHostAppiumUrl(input.resolveAppiumUrl)
          mobileResolved = { ...mobileResolved, appium: { url: appiumUrl, managed: !provided } }
        }
      } catch (err) {
        throw new MobileSetupError({
          category: 'appium-startup',
          message: `Could not auto-start Appium: ${err instanceof Error ? err.message : String(err)}`,
          platform: suitePlatform,
          targetName: suiteResolvedTarget.name,
          deviceName,
          cause: err,
        })
      }
    }

    const adapter = await createPlatformAdapter(suitePlatform, hostSignals)

    const resolvedTarget = suite.target
      ? resolveTarget(config, suite.target)
      : testEntries[0].test.target
        ? resolveTarget(config, testEntries[0].test.target)
        : undefined

    const suiteBrowser = (mergedUse.browser as Record<string, unknown> | undefined) ?? config.use?.browser
    const suiteLogCapture = (mergedUse.logCapture as Record<string, unknown> | undefined) ?? (config as any).use?.logCapture
    const platformConfig = buildPlatformConfig(suitePlatform, resolvedDevice, testTimeouts, suiteBrowser as any, suiteLogCapture, mobileResolved)
    platformConfig.authState = suiteAuthState
    platformConfig.verbose = effectiveLogLevel === 'debug'
    if (opts.headless !== undefined && platformConfig.browser) {
      platformConfig.browser.headless = opts.headless
    }

    const recording = resolveRecordingSetting(opts.record, config.services?.recording)
    const anyTestNeedsRecording = testEntries.some(({ test }) => test.meta?.record === true)
    if (recording.enabled || anyTestNeedsRecording) {
      platformConfig.recording = {
        enabled: true,
        videoDir: resolveRecordingStagingDir(configDir),
      }
    }

    // Resolve LLM models
    const { planner: plannerCfg, verifier: verifierCfg, configName } = resolveLLMModels(config)
    const resolvedAuth = await resolveModelAuth(configName, plannerCfg)
    const { profile: plannerProfile, auth: plannerAuth } = toModelProfileAndAuth(plannerCfg, resolvedAuth)
    const { profile: verifierProfile, auth: verifierAuth } = toModelProfileAndAuth(verifierCfg, resolvedAuth)
    const plannerCapabilities = resolveCapabilities(plannerProfile)
    const verifierCapabilities = resolveCapabilities(verifierProfile)
    const plannerDeclared: DeclaredModelProfile = {
      provider: plannerProfile.provider,
      modelId: plannerProfile.model,
      vision: plannerCapabilities.vision,
      maxOutputTokens: plannerCapabilities.maxOutput,
    }
    const verifierDeclared: DeclaredModelProfile = {
      provider: verifierProfile.provider,
      modelId: verifierProfile.model,
      vision: verifierCapabilities.vision,
      maxOutputTokens: verifierCapabilities.maxOutput,
    }
    process.env.AGENT_QA_LLM_MODEL = plannerCfg.model
    process.env.AGENT_QA_LLM_PROVIDER = plannerCfg.provider

    const suiteSecretRedactor = variableContext?.secretRedactor
    const suiteMask = (text: string): string => {
      // a suite run without its redactor never reaches a provider.
      if (suiteSecretRedactor === undefined) {
        throw new Error('This suite run has no secrets redactor; the model request was not sent.')
      }
      return suiteSecretRedactor.redactString(text)
    }
    const plannerModel = createModel(plannerProfile, plannerAuth, suiteMask)
    const verifierModel = createModel(verifierProfile, verifierAuth, suiteMask)
    // D-04 lazy thunk: resolveCapabilities re-reads the profile per call so a mid-run
    // overflow-driven window shrink is picked up on the next turn. Separate instances per
    // role (planner vs verifier) so each owns its own cache anchor.
    const plannerAccounting = createTokenAccounting({ getCapabilities: () => resolveCapabilities(plannerProfile) })
    const verifierAccounting = createTokenAccounting({ getCapabilities: () => resolveCapabilities(verifierProfile) })

    const { LogManager } = await import('@vostride/agent-qa-core')

    const logger = new LogManager({
      runId: process.env.AGENT_QA_RUN_ID || undefined,
      displayLevel: effectiveLogLevel as any,
      ndjson: process.env.AGENT_QA_LIVE_EVENTS === 'true',
      redactor: variableContext?.secretRedactor,
    })

    // Workspace agent-rules injection removed in Phase 373; policy serving returns
    // via Reader L0 policies in Phase 380. Only CLI-internal capability notes remain.
    let suiteCapabilityNotes = ''
    if (suiteLogCapture?.console === false) {
      suiteCapabilityNotes += '\nConsole log capture is DISABLED for this test run. The readConsoleLogs action will return no data. If a test step explicitly requires reading console logs, use stepFailed to fail the step — do not silently pass with empty data.'
    }
    if (suiteLogCapture?.network === false) {
      suiteCapabilityNotes += '\nNetwork log capture is DISABLED for this test run. The readNetworkLogs action will return no data. If a test step explicitly requires reading network logs, use stepFailed to fail the step — do not silently pass with empty data.'
    }
    // The suite planner is constructed while suites are prepared, before the run-fixed build
    // ordinal is minted. A capable profile receives one stable map now; the real memory handlers
    // are installed into that same map after the ordinal is known and before startRun executes.
    // A weak profile receives undefined, preserving D-09 non-registration structurally.
    const deferredNonActionTools: NonActionToolMap | undefined = memoryToolGate(plannerCapabilities)
      ? {}
      : undefined
    // Fresh consumers share the host's accounting, notes and deferred tool map;
    // conversation history remains in the member loop's previousSteps context.
    const createConsumers: CliStepModelScopeOptions['createConsumers'] = models => ({
      planner: new LLMPlanner(models.plannerModel, suitePlatform,
        logger.createScopedLogger('planner'), suiteCapabilityNotes.trim() || undefined,
        plannerAccounting, plannerDeclared, deferredNonActionTools),
      verifier: new LLMVerifier(models.verifierModel, verifierAccounting, verifierDeclared),
    })
    const { planner, verifier } = createConsumers({ plannerModel, verifierModel })
    const stepModelScope = createCliStepModelScopeFactory({
      ports: { createModel, createScope: createStepModelScope },
      planner: { profile: plannerProfile, auth: plannerAuth, model: plannerModel },
      verifier: { profile: verifierProfile, auth: verifierAuth, model: verifierModel },
      mask: suiteRunMask,
      createConsumers,
    })

    // 363-09/363-11 (D-01 clean cut, CLI side): the v1 Reporter constructions are GONE. The bus
    // subscribers (console, junit and wire print masked payloads; dashboard ingest; analytics) are
    // attached in the core's `onSession` hook below via `attachRunSubscribers` — the ONE run-level
    // attach point, which moved with the run start it follows. No reporter is threaded into
    // the runner config.

    // Wire the redesigned action cache (runner-local FsActionCache + branch policy), injected into
    // the runner loop's cache port.
    let actionCache: import('@vostride/agent-qa-runner').ActionPlanCache | undefined
    if (suiteEffectiveCacheEnabled) {
      const { resolve } = await import('node:path')
      const ctx = await buildActionCacheContext({
        cacheDir: resolve(configDir, config.services?.cache?.dir ?? RUNTIME_CACHE_DIR),
        disableCache: false,
        saveCache: opts.saveCache === true,
      })
      actionCache = ctx.cache
    }

    // ONE run-scoped working-memory store spans all suite member tests; threaded
    // into each test's runner loop and flushed redacted once at suite end (finally below).
    const suiteWorkingMemory = new WorkingMemoryStore(variableContext?.secretRedactor)

    // ONE run-scoped storage-state store (raw-but-local auth persistence) rooted
    // at the run's `.agent-qa` dir, mirroring the FsActionCache rooting idiom. All fs writes live in
    // runner-local (arch lint: storageNeutral); the runner loop records only { name, fingerprint }.
    const suiteStorageState = await buildStorageStateStore(configDir)

    const captureScreenshots = opts.screenshotMode === 'every-step'

    const suiteArtifactContext = buildRunArtifactContext({
      // an ordinary run artifact. The suite identity survives in the run row's
      // `suite_id` and in this document's own `source.kind: 'suite'` snapshot.
      kind: 'test',
      configContent,
      parsedConfig: config,
      effectiveConfig: { ...config, use: mergedUse },
      envFilePath: variableContext?.resolvedEnvFilePath ?? null,
      rawEnvFileContent: variableContext?.rawEnvFileContent ?? null,
      envFileVars: variableContext?.envFileVars ?? {},
      secretsFileMetadata: variableContext?.secretsFileMetadata ?? null,
      cliVars: variableContext?.cliVars ?? {},
      inlineVars: variableContext?.inlineVars ?? {},
      hooks: hooksContext?.resolvedHooks,
      planner: { provider: plannerCfg.provider, model: plannerCfg.model },
      verifier: { provider: verifierCfg.provider, model: verifierCfg.model },
      platform: suitePlatform,
      target: suiteResolvedTarget,
      deviceName,
      attributes: suiteAttributes,
      timeouts: testTimeouts,
      cache: {
        enabled: suiteEffectiveCacheEnabled,
        dir: config.services?.cache?.dir,
      },
      source: {
        kind: 'suite',
        suiteId: (suite as any)['suite-id'] ?? null,
        name: suite.name,
        filePath: suiteFile,
        rawYaml: suiteFileContent || null,
        resolvedDefinition: suite,
        loadStatus: 'loaded',
        members: suiteMembers,
      },
      secretRedactor: variableContext?.secretRedactor,
    })

    const suiteConfig: RunSuiteConfig = {
      adapter,
      platformConfig,
      planner,
      verifier,
      cache: suiteEffectiveCacheEnabled ? actionCache : undefined,
      // D-08/Q10: the sharp compressor is constructed at the composition root and injected into
      // every member's runner loop (sharp left core).
      compressor: buildScreenshotCompressor(logger?.createScopedLogger('adapter')),
      workingMemory: suiteWorkingMemory,
      storageState: suiteStorageState,
      plannerModel,
      verifierModel,
      captureScreenshots,
      timeouts: testTimeouts,
      logger,
      configContent,
      suiteFileContent,
      envFileVars: variableContext?.envFileVars,
      inlineVars: variableContext?.inlineVars,
      cliVars: variableContext?.cliVars,
      resolvedHooks: hooksContext?.resolvedHooks,
      sandboxOptions: hooksContext?.sandboxOptions,
      logCapture: suiteLogCapture,
      accessibility: config.services?.accessibility,
      accessibilityCheck: runWebAccessibilityCheck,
      vision: resolveVisionConfig(config.services?.vision),
      // resolve the vision gate once per run at the composition root and thread it
      // structurally into the loop. 439 D-19: undeclared vision follows the capability table.
      visionGate: resolveVisionGate({ vision: visionFromConfig(plannerCfg.vision, plannerCapabilities) }),
      authStateCapture: suiteAuthStateCapturePaths
        ? {
            capture: () => captureAuthStateForRun({ adapter, paths: suiteAuthStateCapturePaths }),
            failureSummary: formatAuthStateCaptureFailure(suiteAuthStateCapturePaths),
          }
        : undefined,
      createAdapter: () => createPlatformAdapter(suitePlatform, hostSignals),
      resolveUrl: (targetName: string) => {
        try { return resolveTarget(config, targetName).url } catch { return undefined }
      },
    }
    ;(suiteConfig as any).artifactContext = suiteArtifactContext.artifact
    ;(suiteConfig as any).secretStore = variableContext?.secretStore
    ;(suiteConfig as any).secretRedactor = variableContext?.secretRedactor
    ;(suiteConfig as any).secretsFileMetadata = variableContext?.secretsFileMetadata

    // Suite-level run-scoped values the former runSuite resolved internally, now resolved at the
    // composition root and composed per-member at the CLI. The suite-level orchestration
    // (setup hooks + adapter.setup + nav / teardown + auth capture) runs from the lazy lifecycle
    // hooks the shell drives (suiteSetup/suiteTeardown below).
    const preparedSuiteArtifact = (suiteConfig.artifactContext as { artifact?: Record<string, unknown> } | undefined)?.artifact
      ?? (suiteConfig.artifactContext as Record<string, unknown> | undefined)
    const initialSuiteSandboxOptions = suiteConfig.sandboxOptions && suiteConfig.platformConfig.authState
      ? { ...suiteConfig.sandboxOptions, authState: suiteConfig.platformConfig.authState }
      : suiteConfig.sandboxOptions
    return {
      suiteFile,
      suite,
      suiteKey: suiteFile,
      suiteConfig,
      stepModelScope,
      modelProfiles: { planner: plannerDeclared, verifier: verifierDeclared },
      curationModelDeps: { profile: plannerProfile, auth: plannerAuth },
      testEntries,
      suiteMembers,
      suiteRunId: runId,
      suiteArtifact: preparedSuiteArtifact,
      product: resolvedTarget?.product,
      testFileContents: suiteMembers.map((m) => (typeof m.rawYaml === 'string' ? m.rawYaml : '')),
      suiteHookVars: {},
      suiteSandboxOptions: initialSuiteSandboxOptions,
      results: [],
      perMemberDigests: [],
      bootstrapFailure: undefined,
      suiteWorkingMemory,
      suiteAttributes,
      knowledgeSeed: {
        accounting: plannerAccounting,
        capabilities: plannerCapabilities,
        qaRulesText: suiteCapabilityNotes,
        workingContextText: JSON.stringify({
          suite: { name: suite.name, context: (suite as { context?: string }).context },
          tests: testEntries.map(({ test: entry }) => ({
            name: entry.name,
            context: entry.context,
            steps: entry.steps,
          })),
        }),
        deferredNonActionTools,
      },
    }
  }

  // Suite-level SETUP the shell runs on the first member of each suite (lazy lifecycle). Fires
  // onSuiteStart/onRunStart, runs suite setup hooks (→ suiteHookVars), then adapter.setup + the
  // suite-URL navigation. A hook/nav failure records `bootstrapFailure` so the member closures
  // synthesize a bootstrap failure (the shell then group-fail-fasts the remaining members).
  const suiteSetup = async (prepared: PreparedSuite): Promise<void> => {
    const { suite, suiteConfig, testEntries } = prepared

    if ((suite as any).setup?.length && suiteConfig.resolvedHooks && prepared.suiteSandboxOptions) {
      const hookDefs: HookDefinition[] = []
      let hookMissing = false
      for (const hookId of (suite as any).setup) {
        const hook = suiteConfig.resolvedHooks.get(hookId)
        if (!hook) { hookMissing = true; break }
        hookDefs.push(hook)
      }
      if (hookMissing) {
        prepared.bootstrapFailure = 'Suite setup hook not found'
        return
      }
      if (hookDefs.length > 0) {
        const envVars: Record<string, string> = {}
        if (suiteConfig.envFileVars) Object.assign(envVars, suiteConfig.envFileVars)
        if (suiteConfig.inlineVars) Object.assign(envVars, suiteConfig.inlineVars)
        if (suiteConfig.cliVars) Object.assign(envVars, suiteConfig.cliVars)
        const { runHooks } = await import('@vostride/agent-qa-runner')
        const hookRun = await runHooks(hookDefs, {
          ...prepared.suiteSandboxOptions,
          secretStore: suiteConfig.secretStore,
          secretRedactor: suiteConfig.secretRedactor,
          envVars: { ...prepared.suiteSandboxOptions.envVars, ...envVars },
        })
        if (!hookRun.allPassed) {
          prepared.bootstrapFailure = 'Suite setup hook failed'
          return
        }
        prepared.suiteHookVars = hookRun.variables
      }
    }

    await suiteConfig.adapter.setup(suiteConfig.platformConfig)

    const initialTargetName = suite.target ?? testEntries[0]?.test.target
    if (suiteConfig.resolveUrl && initialTargetName) {
      const rawSuiteUrl = suiteConfig.resolveUrl(initialTargetName)
      if (rawSuiteUrl) {
        try {
          const navResult = await suiteConfig.adapter.execute({ type: 'navigate', to: 'url', url: rawSuiteUrl } as any)
          if (navResult && navResult.success === false) {
            prepared.bootstrapFailure = navResult.error ?? `Failed to navigate to suite target URL "${rawSuiteUrl}"`
          }
        } catch (err) {
          prepared.bootstrapFailure = err instanceof Error ? err.message : `Failed to navigate to suite target URL "${rawSuiteUrl}"`
        }
      }
    }
  }

  // Suite-level TEARDOWN the shell runs when crossing a suite boundary / at finalize: auth-state
  // capture (when every member ran and passed), suite teardown hooks, adapter.cleanup + memory
  // destroy, the aggregated onRunEnd/onSuiteEnd reporter calls, and the old runSuite `.finally`
  // composition side effects (working-memory flush, dashboard-db close, analytics flush).
  const suiteTeardown = async (prepared: PreparedSuite): Promise<void> => {
    const { suite, suiteConfig, suiteRunId, results } = prepared
    const totalMembers = prepared.testEntries.length

    if (
      suiteConfig.authStateCapture
      && results.length === totalMembers
      && results.length > 0
      && results.every((r) => r.status === 'passed')
    ) {
      try {
        const captured = await suiteConfig.authStateCapture.capture()
        prepared.suiteSandboxOptions = suiteConfig.sandboxOptions
          ? { ...suiteConfig.sandboxOptions, authState: captured }
          : suiteConfig.sandboxOptions
      } catch {
        const captureFailure: TestResult = {
          runId: suiteRunId, name: 'Auth state capture', filePath: '', status: 'failed',
          steps: [], duration: 0, failureSummary: suiteConfig.authStateCapture.failureSummary,
          metadata: { phase: 'auth-state-capture' },
        }
        results.push(captureFailure)
      }
    }

    if ((suite as any).teardown?.length && suiteConfig.resolvedHooks && prepared.suiteSandboxOptions) {
      const teardownVars: Record<string, string> = {}
      if (suiteConfig.envFileVars) Object.assign(teardownVars, suiteConfig.envFileVars)
      if (suiteConfig.inlineVars) Object.assign(teardownVars, suiteConfig.inlineVars)
      if (suiteConfig.cliVars) Object.assign(teardownVars, suiteConfig.cliVars)
      Object.assign(teardownVars, prepared.suiteHookVars)
      const { runHooks } = await import('@vostride/agent-qa-runner')
      for (const hookId of (suite as any).teardown) {
        const hook = suiteConfig.resolvedHooks.get(hookId)
        if (!hook) continue
        try {
          await runHooks([hook], {
            ...prepared.suiteSandboxOptions,
            secretStore: suiteConfig.secretStore,
            secretRedactor: suiteConfig.secretRedactor,
            envVars: { ...prepared.suiteSandboxOptions.envVars, ...teardownVars },
          })
        } catch {}
      }
    }

    try { await suiteConfig.adapter.cleanup() } catch {}

    await flushWorkingMemory(prepared.suiteWorkingMemory, {
      artifactsDir: resolvePath(configDir, config.services?.dashboard?.artifactsDir ?? RUNTIME_ARTIFACTS_DIR),
      mask: suiteRunMask,
    })
    input.terminal?.printRunAttributes(prepared.suiteAttributes)
  }

  // ---- Compose the ONE RunSession per invocation (D-01/D-04, SESSION-01/04/05) ---------------
  // Resolve every suite up front (parse/target/model/reporter/cache resolution + suiteConfig).
  // resolution errors are `CliRunInputError` throws inside `prepareSuite` now (the same
  // config-error contract, D-14, minus the dead host — T-401-31).
  const preparedSuites: PreparedSuite[] = []
  for (const suiteFile of suiteFiles) {
    const suite = parsedSuiteDefinitions.get(suiteFile)
    if (suite === undefined) throw new Error(`Suite preflight was not retained for ${suiteFile}`)
    preparedSuites.push(await prepareSuite(suiteFile, suite))
  }

  // Flat ordered member list across all suites (file order, then in-suite order). Each member's
  // failFastGroup = its suite file, preserving today's within-suite fail-fast while other suites
  // still run. testIndex = global array position (the shell's authoritative index).
  //
  // descriptor `filePath` is the WORKSPACE-RELATIVE identity, not the
  // absolute path. RUN_OUTCOMES_PROJECTION_VERSION is deliberately NOT bumped alongside it: a
  // projection rebuild replays stored handoffs, which still carry the absolute identities their runs
  // wrote, so the rebuild would land in the same mixed state it was meant to clear. Pre-390-08 rows
  // simply age out of the 5-ordinal recurrence window instead, and detection state is machine-local
  // by posture anyway — D-01's accepted cost, paid once, while zero ledgers exist in the wild.
  const members: RunMemberDescriptor[] = []
  const bindings: SuiteMemberBinding[] = []
  /** Each suite member's OWN `use`, for the per-member concurrency opt-out. */
  const suiteMemberUses: (Record<string, unknown> | undefined)[] = []
  const digestMembers: Array<{ testFileContent: string; suiteFileContent?: string }> = []
  let perMemberDigests: ConfigDigests[] = []
  const suitePlannerMembers: MemberPlannerLimits[] = []

  for (let suiteIndex = 0; suiteIndex < preparedSuites.length; suiteIndex++) {
    const prepared = preparedSuites[suiteIndex]
    for (let i = 0; i < prepared.testEntries.length; i++) {
      // Both legs are in scope below under their own names (see `SuiteTestEntry`): the descriptor
      // carries `identityPath`, every byte read carries `absolutePath`.
      const { test, absolutePath, identityPath } = prepared.testEntries[i]
      suiteMemberUses.push(test.use as Record<string, unknown> | undefined)
      // suites stop ignoring use.planner.*; the same helper as the direct producer.
      const plannerConfig = memberPlannerConfig(
        { project: config.use, suite: prepared.suite.use, test: test.use },
        5,
      )
      suitePlannerMembers.push({ testName: test.name, filePath: identityPath, limits: plannerConfig })
      const globalIndex = members.length
      const memberSuiteIndex = i
      members.push({
        testId: (test as any)['test-id'] ?? test.name,
        testIndex: globalIndex,
        name: test.name,
        failFastGroup: prepared.suiteKey,
        // every suite member shares its suite's ONE adapter, and the suite
        // lifecycle admits one active suite at a time — so suite members declare the exclusive
        // lane and the bounded member pool never runs two of them at once, whatever `workers`
        // says. The direct path declares no lane because each direct test builds its own adapter.
        exclusiveLane: SUITE_LIFECYCLE_LANE,
        // parity descriptor fields the shell rides onto testStarted. Suite grouping is
        // per-suite (id/name/index/total); filePath + totalSteps are per-member.
        filePath: identityPath,
        suiteId: prepared.suite['suite-id'],
        suiteName: prepared.suite.name,
        suiteIndex,
        suiteTotal: preparedSuites.length,
        totalSteps: test.steps.length,
        // read off the unpatched test; patchTestForSuite leaves steps alone and
        // toMemberTest passes them through, so these are the texts stepStarted announces.
        stepTexts: test.steps.map((step) => memberStepText(step)),
      })
      digestMembers.push({
        testFileContent: prepared.testFileContents[i] ?? '',
        suiteFileContent: prepared.suiteConfig.suiteFileContent,
      })
      bindings.push({
        suiteKey: prepared.suiteKey,
        hooks: {
          setup: () => suiteSetup(prepared),
          teardown: () => suiteTeardown(prepared),
        },
        // the suite's one adapter, read by the executor only for its live-stream
        // declaration once `ensureReady` has resolved the suite setup that calls `adapter.setup()`.
        adapter: prepared.suiteConfig.adapter,
        run: async (ctx) => {
          if (prepared.bootstrapFailure) {
            const bootstrapResult: TestResult = {
              runId: prepared.suiteRunId, name: test.name, filePath: absolutePath, status: 'failed',
              steps: [], duration: 0, failureSummary: prepared.bootstrapFailure,
              metadata: { phase: 'suite-bootstrap' },
            }
            prepared.results.push(bootstrapResult)
            return bootstrapResult
          }

          // the per-member orchestration that used to live in core's
          // executeSuiteMember now runs at the CLI composition root — patch the test for the suite,
          // run per-test setup hooks, init the core-owned memory index, execute on runner soil via
          // runMemberTest (buildMemberRunConfig injects the adapter-backed handlers), run per-test
          // teardown hooks, then destroy the memory index + run the core-owned curator.
          const suiteConfig = prepared.suiteConfig
          const patched = patchTestForSuite(test, prepared.suite, memberSuiteIndex)
          const secretStore = (suiteConfig as any).secretStore
          const secretRedactor = (suiteConfig as any).secretRedactor

          // Per-test SETUP hooks (before each test).
          let perTestHookVars: Record<string, string> = {}
          let perTestSetupFailed = false
          if ((patched as any).setup?.length && suiteConfig.resolvedHooks && prepared.suiteSandboxOptions) {
            const hookDefs: HookDefinition[] = []
            let hookMissing = false
            for (const hookId of (patched as any).setup) {
              const hook = suiteConfig.resolvedHooks.get(hookId)
              if (!hook) { hookMissing = true; break }
              hookDefs.push(hook)
            }
            if (!hookMissing && hookDefs.length > 0) {
              const { runHooks } = await import('@vostride/agent-qa-runner')
              const allVars: Record<string, string> = {}
              if (suiteConfig.envFileVars) Object.assign(allVars, suiteConfig.envFileVars)
              if (suiteConfig.inlineVars) Object.assign(allVars, suiteConfig.inlineVars)
              if (suiteConfig.cliVars) Object.assign(allVars, suiteConfig.cliVars)
              Object.assign(allVars, prepared.suiteHookVars)
              for (const hookDef of hookDefs) {
                const hookResult = await runHooks([hookDef], {
                  ...prepared.suiteSandboxOptions,
                  secretStore,
                  secretRedactor,
                  envVars: { ...prepared.suiteSandboxOptions.envVars, ...allVars, ...perTestHookVars },
                  emit: ctx.events,
                  identity: { phase: 'setup', scope: 'test', testIndex: memberSuiteIndex },
                })
                const hr = hookResult.results.get(hookDef.name)
                if (!hr?.success) { hookMissing = true; break }
                Object.assign(perTestHookVars, hr.variables)
                Object.assign(allVars, hr.variables)
              }
            }
            if (hookMissing) perTestSetupFailed = true
          }

          if (perTestSetupFailed) {
            const setupFailureResult: TestResult = {
              runId: undefined, name: test.name, filePath: absolutePath, status: 'failed', steps: [],
              duration: 0, failureSummary: 'Setup hook failed', metadata: { phase: 'per-test-setup' },
            }
            prepared.results.push(setupFailureResult)
            return setupFailureResult
          }

          const memberRunConfig = Object.assign(buildMemberRunConfig({
            adapter: suiteConfig.adapter,
            planner: suiteConfig.planner,
            verifier: suiteConfig.verifier,
            cache: suiteConfig.cache,
            workingMemory: suiteConfig.workingMemory,
            storageState: suiteConfig.storageState,
            compressor: suiteConfig.compressor,
            knowledgeReader: prepared.knowledge?.reader,
            // the rung this run was SERVED on, resolved once when the composition
            // opened and carried into every step's evidence — so a run served on the static
            // floor stays labelled that way forever, even after the host is fixed.
            knowledgeRetrievalRung: prepared.knowledge?.retrievalRung,
            knowledgeBudgets: prepared.knowledge?.budgets,
            // Read at call time: these bindings are constructed before the gate, and the ordinal is
            // assigned by the assembler the core calls after it.
            knowledgeAsOfBuild: suiteBuildOrdinal,
            recordLedger: prepared.knowledge?.recordLedger,
            beginMemoryTurn: prepared.knowledge?.beginMemoryTurn,
            drainMemoryReadTraces: prepared.knowledge?.drainMemoryReadTraces,
            configDigests: perMemberDigests[globalIndex],
            plannerModel: suiteConfig.plannerModel,
            verifierModel: suiteConfig.verifierModel,
            stepModelScope: bindMemberStepModelScope(ctx, prepared.stepModelScope),
            envFileVars: suiteConfig.envFileVars,
            inlineVars: suiteConfig.inlineVars,
            suiteVars: prepared.suiteHookVars,
            cliVars: suiteConfig.cliVars,
            hookSetupVars: perTestHookVars,
            inlineHookDefs: suiteConfig.resolvedHooks,
            sandboxOptions: prepared.suiteSandboxOptions,
            secretStore,
            secretRedactor,
            sink: ctx.events,
            testIndex: ctx.testIndex,
            abortSignal: ctx.abortSignal,
            // bind the run-scoped screenshot store the shell threaded onto the member ctx.
            evidenceArtifacts: ctx.evidenceArtifacts,
            captureScreenshots: suiteConfig.captureScreenshots,
            accessibility: suiteConfig.accessibility,
            timeouts: suiteConfig.timeouts,
            logger: suiteConfig.logger,
            logCapture: suiteConfig.logCapture,
            vision: suiteConfig.vision,
            visionGate: suiteConfig.visionGate,
            contextWindow: prepared.knowledgeSeed.capabilities.contextWindow,
            plannerConfig,
            suiteContext: (prepared.suite as any).context,
            filePath: absolutePath,
          }), {
            recording: resolveRecordingSetting(opts.record, config.services?.recording, test.meta?.record),
            modelProfiles: prepared.modelProfiles,
            onEvidenceContext: ctx.setEvidenceContext,
          })
          const result = await runMemberTest(toMemberTest(patched, absolutePath), memberRunConfig)

          // Per-test TEARDOWN hooks (after each test).
          if ((patched as any).teardown?.length && suiteConfig.resolvedHooks && prepared.suiteSandboxOptions) {
            const { runHooks } = await import('@vostride/agent-qa-runner')
            for (const hookId of (patched as any).teardown) {
              const hook = suiteConfig.resolvedHooks.get(hookId)
              if (!hook) continue
              try {
                const teardownVars: Record<string, string> = {}
                if (suiteConfig.envFileVars) Object.assign(teardownVars, suiteConfig.envFileVars)
                if (suiteConfig.cliVars) Object.assign(teardownVars, suiteConfig.cliVars)
                Object.assign(teardownVars, prepared.suiteHookVars, perTestHookVars)
                await runHooks([hook], {
                  ...prepared.suiteSandboxOptions,
                  secretStore,
                  secretRedactor,
                  envVars: { ...prepared.suiteSandboxOptions.envVars, ...teardownVars },
                  emit: ctx.events,
                  identity: { phase: 'teardown', scope: 'test', testIndex: memberSuiteIndex },
                })
              } catch { /* teardown hook failure is best-effort */ }
            }
          }

          prepared.results.push(result)
          return result
        },
      })
    }
  }

  // the ONE digest mint — per-member cache pairs + the run-level handoff pair; both consumers
  // (per-member cache via ctx, run-level handoff via RunConfig) draw from this single call.
  const runDigests = computeRunConfigDigests({ configContent, members: digestMembers })
  perMemberDigests = runDigests.perMember

  const runProduct = suitePreflightProduct
    ?? preparedSuites.find((p) => p.product)?.product
    ?? 'unknown'

  const buildTag = resolveBuildTagSetting({
    flag: opts.buildTag,
    env: process.env.AGENT_QA_BUILD_TAG,
    use: config.use,
  })
  const knowledgeRoot = resolveKnowledgeRoot(config.knowledge, configDir)

  // Each member's probe URL, resolved as a config read only — the probe that fetches the URL runs
  // inside `assembleCliRun`. PER MEMBER, in the member array's own order — the same nesting
  // `members` above was pushed in, so `facts.probeUrls[i]` belongs to `members[i]`. A suite-level
  // `target:` is what `patchTestForSuite` gives every one of that suite's members, so it is that
  // member's target.
  const suiteMemberTargetNames: (string | undefined)[] = []
  for (const prepared of preparedSuites) {
    for (const entry of prepared.testEntries) {
      suiteMemberTargetNames.push(prepared.suite.target ?? entry.test.target)
    }
  }
  const suiteTargetFacts = resolveMemberTargetFacts(config, suiteMemberTargetNames)

  // Assigned by the assembler, which the core calls only after the gate allows the run. Both are
  // read strictly downstream of that call — the ordinal by the member closures (`asOfBuild`) and by
  // the D-23 knowledge bind inside the assembler, the quarantine set by the reporters.
  let suiteBuildOrdinal = 0
  let suiteQuarantined: readonly QuarantineAppliedEntry[] = []

  const lifecycle = createSuiteLifecycle()
  const executor = buildSuiteMemberExecutor({ lifecycle, bindings })

  // The run line reads the project, and the suite's block when the run is one suite; members whose
  // own limits differ are listed per test.
  const suitePlannerLimits = plannerLimitsRecord(
    resolvePlannerLimits(config.use, ...(preparedSuites.length === 1 ? [preparedSuites[0].suite.use] : [])),
    suitePlannerMembers,
  )

  // the suite's own source and config, masked with the run's redactor. The channel
  // replays to late listeners, so they are emitted once, as the producer returns.
  for (const prepared of preparedSuites) {
    if (isSnapshotRecord(prepared.suiteArtifact)) {
      suiteSnapshots.emit(maskRunArtifactSnapshot(prepared.suiteArtifact, { mask: suiteRunMask }))
    }
  }

  return {
    members,
    executor,
    configDigests: runDigests.runLevel,
    product: runProduct,
    plannerLimits: suitePlannerLimits,
    configDir,
    configFilePath,
    knowledgeRoot,
    memberProbeUrls: suiteTargetFacts.probeUrls,
    concurrency: resolveRunConcurrencyConfig(
      config.use as Record<string, unknown> | undefined,
      opts,
      suiteMemberUses,
    ),
    ...(buildTag === undefined ? {} : { buildTag }),
    logger: { setRunId: () => { /* the suite path stamps its loggers per prepared suite */ } },
    secretRedactor: suiteRunSecretRedactor,
    loadPlugins: input.loadPlugins,
    ...(config.services?.dashboard?.dbPath === undefined
      ? {}
      : { configuredRunsDbPath: config.services.dashboard.dbPath }),
    runArtifact: stagedRunArtifact(
      suiteRunSource(preparedSuites.map((prepared) => prepared.suiteArtifact)),
      suiteMemberTargetNames,
      suiteRunMask,
    ),
    subscriberSeed: (() => {
      const first = preparedSuites[0]
      if (first === undefined) return {}
      const suiteArtifact = first.suiteArtifact as { config?: unknown; source?: unknown } | undefined
      return {
        configSnapshot: suiteArtifact?.config,
        sourceSnapshot: suiteArtifact?.source,
        attributes: first.suiteAttributes,
      }
    })(),
    onMemberSnapshot: suiteSnapshots.subscribe,
    applyAssembly: ({ buildOrdinal, quarantined }) => {
      suiteBuildOrdinal = buildOrdinal
      suiteQuarantined = quarantined
    },
    bindSession: (session) => { activeRunSession = session },
    takeFrameworkError: () => undefined,
    getCurationModelDeps: () => preparedSuites[0]?.curationModelDeps,
    finalize: () => lifecycle.finalize(),
    // The D-23 knowledge bind needs the ordinal the assembler just advanced, and every prepared
    // planner's memoised composition has to exist before a member can execute. It rides here rather
    // than in the door's assembler closure so BOTH doors get it from the producer that owns the
    // prepared suites.
    bindKnowledge: (buildOrdinal: number) => {
      for (const prepared of preparedSuites) {
        const knowledge = openRunKnowledgeComposition({
          knowledgeRoot,
          // the hosted runtime root the embedder probe discovers its worker under —
          // the same `resolvePath(configDir, '.agent-qa')` idiom every other door here uses.
          agentQaRoot: resolvePath(configDir, '.agent-qa'),
          resolveRetrievalRung: resolveHostRetrievalRung,
          product: prepared.product ?? runProduct,
          scope: { tier: 'product', key: prepared.product ?? runProduct },
          parentScopes: [{
            tier: 'suite',
            key: prepared.suite['suite-id'] ?? prepared.suite.name,
          }],
          asOfBuild: buildOrdinal,
          capabilities: prepared.knowledgeSeed.capabilities,
          accounting: prepared.knowledgeSeed.accounting,
          qaRulesText: prepared.knowledgeSeed.qaRulesText,
          workingContextText: prepared.knowledgeSeed.workingContextText,
        })
        prepared.knowledge = knowledge
        const deferred = prepared.knowledgeSeed.deferredNonActionTools
        if (deferred !== undefined && knowledge.nonActionTools !== undefined) {
          Object.assign(deferred, knowledge.nonActionTools)
        }
      }
    },
  }
}

/**
 * THE TEST-HALF MEMBER PRODUCER.
 *
 * `assembleCliRun` requires `members` and an `executor`; a `RunsStartInput` carries neither; and the
 * chain that turns one into the other lived unexported inside this command's action body. That is
 * the wall 401-06 halted on, and this function is the door out of it: the SAME producer both the
 * `agent-qa run` single-test path and every programmatic door reach, so there is one members/executor
 * assembly on this door rather than one per caller.
 *
 * IT STAYS IN THIS FILE. The member closure names `@vostride/agent-qa-android`, `-ios`, `-web`,
 * `-model`, `-runner`, `-runner-local` and `-core`; `commands/run.ts` is the ONLY cli file ledgered
 * for those under FUNC-02's surface firewall, the ledger only ever shrinks, and a file written after
 * 2026-07-28 can never join it. What moved to `composition/in-process-run-execution.ts` is the
 * COMPOSITION; the vocabulary stayed where the build allows it. A later reader who "tidies" this
 * into a new module will be refused by the arch package tests, not by a review comment.
 *
 * WHAT IT DOES NOT DO. It does not resolve an execution context (the DOOR does, D-07), it does not
 * register signal handlers, it does not build the audit sink (the drive does, once), and it cannot
 * terminate its host: the one refusal it makes is a `CliRunInputError`.
 *
 * THE LATE-BOUND SLOTS ARE THE SHIPPED SEMANTICS, PRESERVED. The build ordinal and the quarantine
 * set were `let`s the command assigned after the member closure was defined and the closure read at
 * CALL time — because the ordinal does not exist until the assembler has advanced it, which happens
 * after the gate. `applyAssembly` is that assignment, named.
 */
export interface DirectRunMemberProductionInput {
  /** The resolved preflight — the producer never re-resolves a config a door already read. */
  readonly inputs: RunInvocationInputs
  /** The parsed bindings. `refuseZeroRunnableTests` has already had its say about an empty one. */
  readonly bindings: readonly ParsedTestBinding[]
  /** The invocation's single product, when the door's own preflight already decided it. */
  readonly product?: string
  /** The door's flags. A programmatic door has none, and the empty object is the honest default. */
  readonly opts?: RunOptions
  /** The invocation's memoised analytics host. Absent ⇒ no analytics, the daemon's posture. */
  readonly analytics?: () => Promise<CliAnalyticsHost>
  /**
   * The id the drive decided for this run. A member takes the shell's
   * `ctx.runId` first and this second; it never decides an id of its own.
   */
  readonly runId?: string
  /** Reports each member's own run id. The command uses it to keep its crash-finalizer honest. */
  readonly onMemberRunId?: (runId: string) => void
  readonly terminal?: RunTerminal
  // only agent-qa run passes this; its
  // controller owns SIGINT, SIGTERM and SIGHUP.
  readonly hostOwnsSignals?: true
  /**
   * An Appium a HOST already leased for this run (401-07, D-01/D-12 — INVK-01 truth 5).
   *
   * Absent ⇒ the shipped behaviour: `AGENT_QA_APPIUM_URL`, then the bundled auto-start. Present ⇒
   * the host's URL wins, and this process manages nothing. See `AppiumUrlResolver`.
   */
  readonly resolveAppiumUrl?: AppiumUrlResolver
}

/** A minimal view of the log manager, so a caller need not name `@vostride/agent-qa-core`'s class. */
export interface CliRunLoggerHandle {
  setRunId(runId: string): void
}

/**
 * What a member producer answers: everything `assembleCliRun` needs that only a door can build,
 * plus the four late bindings the run's own lifecycle fills in.
 */
export interface ProducedCliRunMembers {
  readonly members: readonly RunMemberDescriptor[]
  readonly executor: MemberTestExecutor
  readonly configDigests: ConfigDigests
  readonly product: string
  /**
   * The run's effective planner limits and the members whose own limits differ, from
   * the same per-member resolution the member closures run under.
   */
  readonly plannerLimits?: PlannerLimitsRecord
  readonly configDir: string
  readonly configFilePath: string
  readonly knowledgeRoot: string
  /**
   * ONE ENTRY PER MEMBER, in `members` order: the URL whose health reading belongs to THAT member,
   * or `undefined` for a member no probe applies to.
   *
   * A config read — the fetch itself happens inside `assembleCliRun`, which dedupes by URL so members sharing a target cost one GET.
   */
  readonly memberProbeUrls: readonly (string | undefined)[]
  /**
   * The run's CONFIG-RESOLVED concurrency pair — `use.parallel` and `use.workers`
   * as the producer read them, with this command's two flags already folded in by the ordinary
   * `use`-bucket precedence.
   *
   * RAW, NOT A COUNT. The count is `resolveEffectiveWorkers`'s to decide and the drive's to apply,
   * because the formula needs the member count and the member count is what THIS object carries.
   * A producer that resolved the count itself would be a second site for the default.
   *
   * IT TRAVELS ON THE PRODUCED OBJECT rather than on the drive's options because that is the ONE
   * channel both doors traverse: `agent-qa run` hands the drive members it produced itself, and a
   * bare `runs.start` reaches the same producers through `produceMembersFromPatterns`. A drive-side
   * config read would have been absent for the first door and present for the second.
   */
  readonly concurrency?: { readonly parallel?: boolean; readonly workers?: number }
  readonly buildTag?: string
  /**
   * The run's log manager, when the producer built one. The suite half stamps its loggers per
   * prepared suite and has no run-level one, so this is optional rather than a no-op stub.
   */
  readonly logger?: CliRunLoggerHandle
  /**
   * The run's redactor over the secrets read at its start. The drive puts it on
   * `RunConfig.secretRedactor`, and the shell masks every bus event with it.
   */
  readonly secretRedactor: SecretRedactorPort
  /** What the run's record needs and only the producer knows: the snapshots and attributes the wire omits. */
  readonly subscriberSeed?: {
    readonly configSnapshot?: unknown
    readonly sourceSnapshot?: unknown
    readonly attributes?: RunAttributes
  }
  /**
   * The producer's snapshot channel: each member's loaded test and config, and a
   * suite's own source and config, masked with the run's redactor. Late listeners get a replay.
   */
  readonly onMemberSnapshot?: (listener: RunArtifactSnapshotListener) => () => void
  /**
   * The D-23 live knowledge bind, which needs the ordinal the assembler just advanced. Suite-only:
   * it opens one memoised reader/ledger/tool composition per prepared planner before any member can
   * execute, and it cannot precede the verdict because the ordinal is a durable write.
   */
  bindKnowledge?(buildOrdinal: number): void
  /** The assembler's results, bound after the gate allowed the run and before `startRun`. */
  applyAssembly(input: { buildOrdinal: number; quarantined: readonly QuarantineAppliedEntry[] }): void
  /** The started session. Since 433-35 a member's framework error fails the run rather than cancelling it. */
  bindSession(session: { cancel(): void }): void
  /** The first framework/setup error a member closure threw — the drive re-surfaces it. */
  takeFrameworkError(): unknown | undefined
  /** The planner profile/auth the curation tail reuses, once a member has resolved one. */
  getCurationModelDeps(): CurationTailModelDeps | undefined
  /** Any teardown the producer owns. The suite half finalises its lifecycle here. */
  finalize?(): Promise<void>
  /** The run's plugin load, which the core awaits once the request and its run id are allowed. */
  readonly loadPlugins: () => Promise<void>
  /** The run's own config's `services.dashboard.dbPath`, resolved only when the record opens. */
  readonly configuredRunsDbPath?: string
  /** The masked source and target names the run stages as `artifact.json`. */
  readonly runArtifact?: RunArtifactStageInput
}

export async function produceDirectRunMembers(
  input: DirectRunMemberProductionInput,
): Promise<ProducedCliRunMembers> {
  const {
    config,
    configDir,
    configFilePath,
    configContent,
    runtimeSecrets,
    envFileVars,
    cliVars,
    inlineVars,
    effectiveLogLevel,
    userRunAttributes,
    resolvedHooks,
    sandboxOptions,
    rawEnvFileContent,
    resolvedEnvFilePath,
  } = input.inputs
  const opts: RunOptions = input.opts ?? ({} as RunOptions)
  const analytics = input.analytics
  const onMemberRunId = input.onMemberRunId
  const producedRunId = input.runId
  const filtered = [...input.bindings]
  const memberSnapshots = createRunArtifactSnapshotChannel()
  const directRunProduct = input.product
  const singleRunMask: MaskFn = (text) => runtimeSecrets.secretRedactor.redactString(text)

  // Read before the run is recorded, so a refused local file refuses the run instead of failing it.
  const readLocalBindings = createRunLocalBindingsReader()
  if (anyTargetRunsOnDevice(config, filtered.map(({ test }) => test.target))) readLocalBindings()

  // The late-bound slots the run's own lifecycle fills. `singleRunProduct` and `singleBuildOrdinal` are declared with the block
  // below, exactly where the command declared them; these two are new only in the sense that the
  // command held them in its own scope.
  let frameworkError: unknown | undefined
  let frameworkSkipReason: string | undefined
  // Kept for the producer interface; a framework error no longer cancels the run.
  let activeRunSession: { cancel(): void } | undefined
  void activeRunSession

  // `startRun` is NOT among these. BOTH of this door's paths reach it through
  // `createRunInvocationCore`, and a binding held here would be a second way in.
  // `mapVerdictToExitCode` is not among them either — mapping the verdict belongs to the
  // ONE drive both paths call, not to each path's own copy of the arithmetic.
  const { LLMPlanner, LLMVerifier } = await import('@vostride/agent-qa-runner')

  const recording = resolveRecordingSetting(opts.record, config.services?.recording)

  // Wire action cache from config (logger wired after LogManager creation below)
  let actionCache: import('@vostride/agent-qa-runner').ActionPlanCache | undefined
  let singleCurationModelDeps: CurationTailModelDeps | undefined
  let singleRunProduct = 'unknown'
  let singleBuildOrdinal = 0

  // one run-scoped working-memory store per run, constructed with the run's
  // SecretRedactor (capture-time redaction live); threaded into the loop and flushed
  // redacted at run end (finally-positioned below).
  const singleWorkingMemory = new WorkingMemoryStore(runtimeSecrets.secretRedactor)

  // one run-scoped storage-state store per run, rooted at the run's
  // `.agent-qa` dir (the FsActionCache rooting idiom); threaded into the loop's storageState port.
  const singleStorageState = await buildStorageStateStore(configDir)

  const captureScreenshots = opts.screenshotMode === 'every-step'

  const { LogManager } = await import('@vostride/agent-qa-core')

  const logger = new LogManager({
    runId: process.env.AGENT_QA_RUN_ID || undefined,
    displayLevel: effectiveLogLevel as any,
    ndjson: process.env.AGENT_QA_LIVE_EVENTS === 'true',
    redactor: runtimeSecrets.secretRedactor,
    // the composition root owns every reach into the world, this one included —
    // `core`'s host baseline is a shrinking debt record, so the async-context primitive is injected
    // rather than imported there. Without it `runInMemberScope` throws instead of silently letting
    // concurrent members share one run id.
    memberScope: new AsyncLocalStorage<MemberLogScope>(),
  })

  // Wire the redesigned action cache (runner-local FsActionCache + branch policy); skip when
  // --disable-cache.
  if (opts.disableCache !== true) {
    const { resolve } = await import('node:path')
    const ctx = await buildActionCacheContext({
      cacheDir: resolve(configDir, config.services?.cache?.dir ?? RUNTIME_CACHE_DIR),
      disableCache: false,
      saveCache: opts.saveCache === true,
    })
    actionCache = ctx.cache
  } else {
    const cacheLog = logger.createScopedLogger('cache')
    cacheLog.info('Cache disabled via --disable-cache', { operation: 'bypass' })
  }

  const results: TestResult[] = []

  // each member's limits from its own merged blocks, through the helper the suite
  // producer calls too. Flag overrides carry no planner keys.
  const directPlannerConfigs = filtered.map(({ test }) =>
    memberPlannerConfig({ project: config.use, test: test.use }, 3))

  // One discovered test file = one member closure of the ONE RunSession (SESSION-01/04).
  // Retry stays a single-test-path concern INSIDE this closure (runTestWithRetry); the shell
  // derives the member outcome from the returned final TestResult exactly as for suite members
  // (RESEARCH A2 — the suite path is single-attempt, this path keeps its retry). The run-shell
  // ctx seams (events/abortSignal) and the member's cache digest pair are threaded in.
  const runOneDirectTest = async (
    binding: ParsedTestBinding,
    ctx: MemberTestRunContext,
    perMemberDigest: ConfigDigests | undefined,
    plannerConfig: MemberPlannerConfig,
  ): Promise<TestResult> => {
    const { test, filePath, fileContent: testFileContent } = binding
    let currentPlatform: 'web' | 'android' | 'ios' | null = null
    let currentAdapterKey: string | null = null
    let adapter: import('@vostride/agent-qa-runner').PlatformAdapter | null = null
    let analyticsRunId: string | undefined
    let analyticsFilePath = filePath
    let analyticsPlatform: 'web' | 'android' | 'ios' | undefined
    let analyticsTestId: string | undefined
    let analyticsAttributes: RunAttributes | undefined = buildCliRunAttributes(
      userRunAttributes,
      'local',
    )
    let analyticsAppState: string | undefined
    let analyticsStartedAt = Date.now()
    let completedResult: TestResult | undefined
    try {
    try {
    let testResolvedTarget = resolveTarget(config, test.target!)
    let testTargetUrl = testResolvedTarget.url

    const testDef = {
      ...test,
      url: testTargetUrl,
    }
    analyticsTestId = testDef['test-id']

    // the run core decided this run's id; the member adopts it.
    const runId = ctx.runId ?? producedRunId
    if (runId === undefined) {
      throw new Error('A member needs the run id its run decided; neither the run shell nor the producer supplied one.')
    }
    analyticsRunId = runId
    analyticsStartedAt = Date.now()
    onMemberRunId?.(runId)
    logger.setRunId(runId)

    // Per-test config merge (global config < test YAML use: < CLI flags)
    const testFlagOverrides: Record<string, unknown> = {}
    if (opts.headless !== undefined) testFlagOverrides['browser'] = { headless: opts.headless }
    if (opts.browser) testFlagOverrides['browser'] = { ...(testFlagOverrides['browser'] as Record<string, unknown> ?? {}), name: opts.browser }

    const mergedUse = mergeUseBlocks(
      config.use as Record<string, unknown>,
      undefined,
      test.use as Record<string, unknown> | undefined,
      testFlagOverrides,
    )
    const testMergedConfig = { ...config, use: mergedUse } as AgentQaConfig
    const effectiveCacheEnabled = !opts.disableCache && (mergedUse as Record<string, unknown>).cache !== false

    if (opts.configDebug) {
      printRunText(
        [
          pc.bold(`\nConfig for: ${test.name}`),
          formatConfigDebug(config, test.use, testFlagOverrides, singleRunMask),
          '',
        ].join('\n'),
        (text) => console.log(text),
      )
    }

    const testPlatform: 'web' | 'android' | 'ios' = testResolvedTarget.platform
    analyticsPlatform = testPlatform
    const testAuthStateUse = getSelectedAuthStateUse(mergedUse as Record<string, unknown>)
    const testAuthState = await resolveSelectedAuthStateForRun({
      config,
      configDir,
      resolvedTarget: testResolvedTarget,
      authState: testAuthStateUse,
    })
    const testAuthStateCapturePaths = resolveAuthStateCapturePathsForRun({
      config,
      configDir,
      resolvedTarget: testResolvedTarget,
      authState: testAuthStateUse,
    })
    let activeTestAuthState = testAuthState

    const testMergedUse = (testMergedConfig as any).use ?? (config as any).use ?? {}
    const testDeviceName = opts.device ?? testMergedUse.device as string | undefined

    const testTimeoutsForSetup = {
      step: (testMergedConfig as any).use?.timeout?.step ?? config.use?.timeout?.step,
      test: (testMergedConfig as any).use?.timeout?.test ?? config.use?.timeout?.test,
      navigation:
        (testMergedConfig as any).use?.timeout?.navigation ??
        config.use?.timeout?.navigation ??
        DEFAULT_NAVIGATION_TIMEOUT_MS,
    }

    const testLocalBindings = testPlatform === 'android' || testPlatform === 'ios'
      ? readLocalBindings()
      : null
    let testMobileResolved: ResolvedMobileRunConfig | undefined
    let testResolvedDevice: ResolvedMobileDevice | undefined
    if (testPlatform === 'android' || testPlatform === 'ios') {
      testMobileResolved = resolveMobileRunOrThrow({
        config: config as unknown as Record<string, any>,
        targetName: testResolvedTarget.name,
        platform: testPlatform,
        explicitDeviceName: opts.device,
        useDeviceName: testMergedUse.device as string | undefined,
        appState: testMergedUse.mobile?.appState as 'preserve' | 'reset' | undefined,
        localBindings: testLocalBindings,
        configFilePath: resolvePath(configFilePath),
        localConfigFilePath: testLocalBindings?.filePath,
        appiumUrl: resolveHostAppiumUrl(input.resolveAppiumUrl),
      })
      analyticsAppState = testMobileResolved.appState
      testResolvedDevice = testMobileResolved.device
    }

    const testAttributes = buildCliRunAttributes(userRunAttributes, 'local')
    analyticsAttributes = testAttributes
    const adapterKey = JSON.stringify({
      platform: testPlatform,
      device: testResolvedDevice?.name,
      appPackage: testMobileResolved?.app.appPackage,
      appActivity: testMobileResolved?.app.appActivity,
      bundleId: testMobileResolved?.app.bundleId,
      appPath: testMobileResolved?.app.install?.path,
    })

      // Each direct test owns its adapter so parallel batches cannot share mutable browser/mobile state.
      if (testPlatform !== currentPlatform || adapterKey !== currentAdapterKey) {
        currentPlatform = testPlatform
        currentAdapterKey = adapterKey

        // Auto-start Appium for mobile platforms (if not already running)
        if (testPlatform === 'ios' || testPlatform === 'android') {
          try {
            const appiumUrl = await acquireAppium(effectiveLogLevel, input.resolveAppiumUrl)
            if (testMobileResolved) {
              // See the suite half: a host-leased URL is not this process's to manage.
              const provided = resolveHostAppiumUrl(input.resolveAppiumUrl)
              testMobileResolved = { ...testMobileResolved, appium: { url: appiumUrl, managed: !provided } }
            }
          } catch (err) {
            throw new MobileSetupError({
              category: 'appium-startup',
              message: `Could not auto-start Appium: ${err instanceof Error ? err.message : String(err)}`,
              platform: testPlatform,
              targetName: testResolvedTarget.name,
              deviceName: testDeviceName,
              cause: err,
            })
          }
        }

        adapter = await createPlatformAdapter(
          testPlatform,
          input.hostOwnsSignals === true ? { hostOwnsSignals: true } : {},
        )

        const mergedBrowser = (mergedUse as Record<string, unknown>).browser as Record<string, unknown> | undefined
        const platformConfig = buildPlatformConfig(testPlatform, testResolvedDevice, testTimeoutsForSetup, mergedBrowser ?? config.use?.browser, (testMergedConfig as any).use?.logCapture ?? config.use?.logCapture, testMobileResolved)
        platformConfig.authState = activeTestAuthState
        platformConfig.verbose = effectiveLogLevel === 'debug'
        if (opts.headless !== undefined) {
          if (platformConfig.browser) {
            platformConfig.browser.headless = opts.headless
          }
        }

        // Wire recording config for this platform adapter
        const anyTestNeedsRecording = filtered.some(({ test: candidate }) => candidate.meta?.record === true)
        if (recording.enabled || anyTestNeedsRecording) {
          platformConfig.recording = {
            enabled: true,
            videoDir: resolveRecordingStagingDir(configDir),
          }
        }

        await adapter.setup(platformConfig)

        if (effectiveLogLevel === 'debug') {
          input.terminal?.printDebugLine(`  Platform: ${testPlatform}${testPlatform !== 'web' ? ' (adapter re-created)' : ''}`)
        }
      }

      // Per-test model creation using merged LLM config
      const mergedForLLM = { registry: (config as any).registry, use: (testMergedConfig as any).use ?? (config as any).use }
      const { planner: plannerCfg, verifier: verifierCfg, configName } = resolveLLMModels(mergedForLLM)
      const resolvedAuth = await resolveModelAuth(configName, plannerCfg)
      const { profile: plannerProfile, auth: plannerAuth } = toModelProfileAndAuth(plannerCfg, resolvedAuth)
      const { profile: verifierProfile, auth: verifierAuth } = toModelProfileAndAuth(verifierCfg, resolvedAuth)
      // retain the first already-resolved planner identity used by this RunSession.
      // The post-verdict Curator reuses these exact objects and never resolves config again.
      singleCurationModelDeps ??= { profile: plannerProfile, auth: plannerAuth }
      const plannerCapabilities = resolveCapabilities(plannerProfile)
      const verifierCapabilities = resolveCapabilities(verifierProfile)
      const plannerDeclared: DeclaredModelProfile = {
        provider: plannerProfile.provider,
        modelId: plannerProfile.model,
        vision: plannerCapabilities.vision,
        maxOutputTokens: plannerCapabilities.maxOutput,
      }
      const verifierDeclared: DeclaredModelProfile = {
        provider: verifierProfile.provider,
        modelId: verifierProfile.model,
        vision: verifierCapabilities.vision,
        maxOutputTokens: verifierCapabilities.maxOutput,
      }
      process.env.AGENT_QA_LLM_MODEL = plannerCfg.model
      process.env.AGENT_QA_LLM_PROVIDER = plannerCfg.provider
      if (effectiveLogLevel === 'debug') {
        input.terminal?.printDebugLine(`  Model: ${plannerCfg.model} (${plannerCfg.provider})`)
      }
      const runMask = (text: string) => runtimeSecrets.secretRedactor.redactString(text)
      const plannerModel = createModel(plannerProfile, plannerAuth, runMask)
      const verifierModel = createModel(verifierProfile, verifierAuth, runMask)
      // D-04 lazy thunk + role-separated accounting instances (see suite-level site).
      const plannerAccounting = createTokenAccounting({ getCapabilities: () => resolveCapabilities(plannerProfile) })
      const verifierAccounting = createTokenAccounting({ getCapabilities: () => resolveCapabilities(verifierProfile) })

      const testLogCapture = (testMergedConfig as any).use?.logCapture ?? config.use?.logCapture
      let testCapabilityNotes = ''
      if (testLogCapture?.console === false) {
        testCapabilityNotes += '\nConsole log capture is DISABLED for this test run. The readConsoleLogs action will return no data. If a test step explicitly requires reading console logs, use stepFailed to fail the step — do not silently pass with empty data.'
      }
      if (testLogCapture?.network === false) {
        testCapabilityNotes += '\nNetwork log capture is DISABLED for this test run. The readNetworkLogs action will return no data. If a test step explicitly requires reading network logs, use stepFailed to fail the step — do not silently pass with empty data.'
      }
      const knowledge = openRunKnowledgeComposition({
        knowledgeRoot: resolveKnowledgeRoot(config.knowledge, configDir),
        // same hosted runtime root as the suite door — both doors resolve the rung.
        agentQaRoot: resolvePath(configDir, '.agent-qa'),
        resolveRetrievalRung: resolveHostRetrievalRung,
        product: testResolvedTarget.product,
        scope: { tier: 'test', key: testDef.name },
        asOfBuild: singleBuildOrdinal,
        capabilities: plannerCapabilities,
        accounting: plannerAccounting,
        qaRulesText: testCapabilityNotes,
        workingContextText: JSON.stringify({
          context: testDef.context,
          steps: testDef.steps,
        }),
      })
      const createConsumers: CliStepModelScopeOptions['createConsumers'] = models => ({
        planner: new LLMPlanner(models.plannerModel, testPlatform,
          logger.createScopedLogger('planner'), testCapabilityNotes.trim() || undefined,
          plannerAccounting, plannerDeclared, knowledge.nonActionTools),
        verifier: new LLMVerifier(models.verifierModel, verifierAccounting, verifierDeclared),
      })
      const { planner, verifier } = createConsumers({ plannerModel, verifierModel })
      const stepModelScope = createCliStepModelScopeFactory({
        ports: { createModel, createScope: createStepModelScope },
        planner: { profile: plannerProfile, auth: plannerAuth, model: plannerModel },
        verifier: { profile: verifierProfile, auth: verifierAuth, model: verifierModel },
        mask: singleRunMask,
        createConsumers,
      })

      // Per-test timeouts from merged config
      const testTimeouts = {
        step: testMergedConfig.use?.timeout?.step,
        test: testMergedConfig.use?.timeout?.test,
        navigation: testMergedConfig.use?.timeout?.navigation ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
      }

      const testRecording = resolveRecordingSetting(opts.record, config.services?.recording, testDef.meta?.record)

      const artifactContext = buildRunArtifactContext({
        kind: 'test',
        configContent,
        parsedConfig: config,
        effectiveConfig: testMergedConfig,
        envFilePath: resolvedEnvFilePath,
        rawEnvFileContent,
        envFileVars,
        secretsFileMetadata: runtimeSecrets.secretsFileMetadata,
        cliVars,
        inlineVars,
        hooks: resolvedHooks,
        planner: { provider: plannerCfg.provider, model: plannerCfg.model },
        verifier: { provider: verifierCfg.provider, model: verifierCfg.model },
        platform: testPlatform,
        target: testResolvedTarget,
        deviceName: testDeviceName,
        attributes: testAttributes,
        timeouts: testTimeouts,
        cache: {
          enabled: effectiveCacheEnabled,
          dir: config.services?.cache?.dir,
        },
        source: {
          kind: 'test',
          testId: testDef['test-id'] ?? null,
          name: testDef.name,
          filePath,
          rawYaml: testFileContent || null,
          resolvedDefinition: testDef,
          loadStatus: 'loaded',
        },
        secretRedactor: runtimeSecrets.secretRedactor,
      })
      // this member's test as written and effective config, masked
      // with the run's redactor, for every door's dashboard ingest.
      memberSnapshots.emit(maskRunArtifactSnapshot(artifactContext.artifact, { mask: singleRunMask }))

      const getAuthAwareSandboxOptions = () => sandboxOptions && activeTestAuthState
        ? { ...sandboxOptions, authState: activeTestAuthState }
        : sandboxOptions
      const authAwareSandboxOptions = getAuthAwareSandboxOptions()

      // Per-test setup hooks: run BEFORE test execution
      let perTestSetupVars: Record<string, string> = {}
      let testStartTime = Date.now()
      let setupHookFailed = false
      let setupFailureResult: TestResult | undefined
      if (resolvedHooks && authAwareSandboxOptions && (testDef as any).setup?.length) {
        const { runHooks } = await import('@vostride/agent-qa-runner')
        const hookDefs: HookDefinition[] = []
        let hookSetupError: string | undefined
        for (const hookId of (testDef as any).setup) {
          const hook = resolvedHooks.get(hookId)
          if (!hook) { hookSetupError = `Hook ID "${hookId}" not found in hooks registry`; break }
          hookDefs.push(hook)
        }

        if (!hookSetupError && hookDefs.length > 0) {
          const allVars: Record<string, string> = { ...envFileVars }
          if (inlineVars) Object.assign(allVars, inlineVars)
          if ((testDef as any).variables) Object.assign(allVars, (testDef as any).variables)
          if (cliVars) Object.assign(allVars, cliVars)

          for (const hookDef of hookDefs) {
            const hookResult = await runHooks([hookDef], {
              ...authAwareSandboxOptions,
              envVars: { ...authAwareSandboxOptions.envVars, ...allVars, ...perTestSetupVars },
              emit: ctx.events,
              identity: { phase: 'setup', scope: 'test', testIndex: ctx.testIndex },
            })
            const hr = hookResult.results.get(hookDef.name)
            if (!hr?.success) {
              hookSetupError = `Setup hook "${hookDef.name}" failed: ${hr?.error ?? 'unknown'}`
              break
            }
            Object.assign(perTestSetupVars, hr.variables)
            Object.assign(allVars, hr.variables)
          }
        }

        if (hookSetupError) {
          setupHookFailed = true
          const setupResult: TestResult = {
            runId,
            name: test.name,
            filePath,
            status: 'failed',
            steps: [],
            duration: Date.now() - testStartTime,
            failureSummary: hookSetupError,
          }
          results.push(setupResult)
          setupFailureResult = setupResult
          input.terminal?.printRunAttributes(testAttributes)
        }
      }

      if (setupHookFailed) {
        // Synthesized failed TestResult feeds the shell's member-outcome derivation.
        return setupFailureResult!
      }

      // execute the member on runner soil via runMemberTest. The core
      // runTest/runTestWithRetry wrapper is deleted; retry lives inside runMemberTest, and the
      // adapter-backed handlers (runJS/appium/a11y/failure-shot) + secret resolver are wired by
      // the shared buildMemberRunConfig helper (Pitfall 8 — the suite path uses the same helper).
      // the direct path's adapter is set up above; declare its live stream before the
      // first step so a viewer attaching to this handle sees the member's own browser.
      registerAdapterLiveStream(ctx, adapter ?? undefined)

      const memberRunConfig = Object.assign(buildMemberRunConfig({
        adapter: adapter!,
        planner,
        verifier,
        cache: effectiveCacheEnabled ? actionCache : undefined,
        // D-08/Q10: the sharp compressor injected from the composition root (sharp left core).
        compressor: buildScreenshotCompressor(logger?.createScopedLogger('adapter')),
        knowledgeReader: knowledge.reader,
        // see the suite door above — one resolve per run, carried, never re-probed.
        knowledgeRetrievalRung: knowledge.retrievalRung,
        knowledgeBudgets: knowledge.budgets,
        knowledgeAsOfBuild: singleBuildOrdinal,
        recordLedger: knowledge.recordLedger,
        beginMemoryTurn: knowledge.beginMemoryTurn,
        drainMemoryReadTraces: knowledge.drainMemoryReadTraces,
        workingMemory: singleWorkingMemory,
        storageState: singleStorageState,
        configDigests: perMemberDigest,
        plannerModel,
        verifierModel,
        stepModelScope: bindMemberStepModelScope(ctx, stepModelScope),
        envFileVars,
        inlineVars,
        cliVars,
        hookSetupVars: perTestSetupVars,
        inlineHookDefs: resolvedHooks,
        sandboxOptions: authAwareSandboxOptions,
        secretStore: runtimeSecrets.secretStore,
        secretRedactor: runtimeSecrets.secretRedactor,
        // D-02/D-03/D-20 run-shell seams: live event sink + run-level cancel + the member's
        // cache digest pair.
        sink: ctx.events,
        testIndex: ctx.testIndex,
        abortSignal: ctx.abortSignal,
        // bind the run-scoped screenshot store the shell threaded onto the member ctx.
        evidenceArtifacts: ctx.evidenceArtifacts,
        captureScreenshots,
        accessibility: config.services?.accessibility,
        timeouts: testTimeouts,
        plannerConfig,
        logger,
        logCapture: testLogCapture,
        vision: resolveVisionConfig(config.services?.vision),
        visionGate: resolveVisionGate({ vision: visionFromConfig(plannerCfg.vision, plannerCapabilities) }),
        contextWindow: plannerCfg.contextWindow,
        filePath,
      }), {
        recording: testRecording,
        modelProfiles: { planner: plannerDeclared, verifier: verifierDeclared },
        onEvidenceContext: ctx.setEvidenceContext,
      })
      const result = await runMemberTest(toMemberTest(testDef, filePath), memberRunConfig)

      if (!result.runId) result.runId = runId
      completedResult = result

      if (testAuthStateCapturePaths && result.status === 'passed') {
        try {
          activeTestAuthState = await captureAuthStateForRun({
            adapter: adapter!,
            paths: testAuthStateCapturePaths,
          })
        } catch {
          result.status = 'failed'
          result.failureSummary = formatAuthStateCaptureFailure(testAuthStateCapturePaths)
          result.metadata = {
            ...result.metadata,
            phase: 'auth-state-capture',
          }
        }
      }

      const teardownSandboxOptions = getAuthAwareSandboxOptions()

      // Per-test teardown hooks: run AFTER test execution
      if (resolvedHooks && teardownSandboxOptions && (testDef as any).teardown?.length) {
        const { runHooks } = await import('@vostride/agent-qa-runner')
        for (const hookId of (testDef as any).teardown) {
          const hook = resolvedHooks.get(hookId)
          if (!hook) continue
          try {
            const allVars: Record<string, string> = { ...envFileVars, ...perTestSetupVars }
            if (cliVars) Object.assign(allVars, cliVars)
            await runHooks([hook], {
              ...teardownSandboxOptions,
              envVars: { ...teardownSandboxOptions.envVars, ...allVars },
              emit: ctx.events,
              identity: { phase: 'teardown', scope: 'test', testIndex: ctx.testIndex },
            })
          } catch {}
        }
      }

      results.push(result)
      input.terminal?.printRunAttributes(testAttributes)

      // Post-run cache invalidation is no longer done here:
      // the redesigned per-key ActionPlanCache invalidates the exact failed decision
      // point inside the runner loop (loop/index.ts on a failed step). The retired v1
      // batch recompute cannot reproduce the new opaque masked keys (they fold a runtime
      // screenIdentityHash and carry no raw step text on disk, D-06), so the loop owns
      // invalidation and no CLI-side key recompute remains.

      return result
    } finally {
      if (adapter) await adapter.cleanup()
      // redacted flush + disposal on every run outcome (pass/fail/error).
      // The helper never throws, so the run exit code is untouched (Pitfall 5).
      await flushWorkingMemory(singleWorkingMemory, {
        artifactsDir: resolvePath(configDir, config.services?.dashboard?.artifactsDir ?? RUNTIME_ARTIFACTS_DIR),
        mask: singleRunMask,
      })
    }
    } catch (err) {
      // mobile setup-failure telemetry previously fed the v1 AnalyticsRunReporter
      // here. Analytics now rides the bus via `createAnalyticsRunSubscriber`; a pre-runner setup
      // failure re-throws (below) into the framework-error path and emits no testFinished envelope,
      // so this niche pre-runner telemetry is a known gap (re-addressable when the runner emits a
      // failure envelope for it). The normal completion path is fully covered by the bus subscriber.
      throw err
    }
  }
  // Parser-minted bindings are the ONE source for member identity and digest bytes.
  // Digests must still be resolved before startRun.
  //
  // `configDir` is handed in so the descriptor's identity leg is the
  // WORKSPACE-RELATIVE form of the binding's own path — the same bytes on every checkout, which
  // is what lets the committed ledger written on one machine suppress on another. The bindings
  // keep their absolute paths for every read below.
  const { members, digestMembers } = buildDirectRunMembers(filtered, configDir)
  let perMemberDigests: ConfigDigests[] = []
  //
  // `logger` is ONE manager for the whole run (built above, outside this closure) and
  // each member stamps it with its own run id. Since 402-02/402-03 these members run CONCURRENTLY
  // whenever `use.parallel` is set, and an unscoped stamp is a single mutable field — the last
  // member to mint an id claimed every buffered line, its siblings' included. Each member therefore
  // executes inside its own log scope. The suite path needs none: it stamps a logger per prepared
  // suite and reports no run-level one.
  const memberBindings: Array<(ctx: MemberTestRunContext) => Promise<TestResult>> =
    filtered.map((binding, testIndex) =>
      (ctx) => logger.runInMemberScope(
        () => runOneDirectTest(binding, ctx, perMemberDigests[testIndex], directPlannerConfigs[testIndex]),
      ),
    )

  // the ONE digest mint — per-member cache pairs (suiteFileContent absent ⇒ a
  // single-member run collapses the run-level pair to the member values).
  const runDigests = computeRunConfigDigests({ configContent, members: digestMembers })
  perMemberDigests = runDigests.perMember

  // RUNX-06 invariant (defense-in-depth): the `filtered.length === 0` guard above makes this
  // unreachable, but assert it at the session boundary so no future refactor can start a
  // zero-member RunSession that renders a silent "0 of 0" summary.
  if (members.length === 0) {
    throw new CliRunInputError(
      [pc.red('Error: Refusing to start a run with zero members (no runnable tests resolved).')],
      2,
    )
  }

  // Each member's probe URL, resolved as a config read — the probe that fetches the URL runs inside
  // `assembleCliRun`. `filtered` is what `buildDirectRunMembers` mapped 1:1 into `members`, so the
  // facts below are index-aligned with the member array and each member's probe URL is its own.
  const directTargetFacts = resolveMemberTargetFacts(
    config,
    filtered.map((binding) => binding.test.target),
  )
  // `requireSingleInvocationProduct` upstream already guarantees ONE product across the members, so
  // the first resolvable member's product is the invocation's product.
  singleRunProduct = directRunProduct ?? directTargetFacts.firstResolvedProduct ?? 'unknown'
  const singleBuildTag = resolveBuildTagSetting({
    flag: opts.buildTag,
    env: process.env.AGENT_QA_BUILD_TAG,
    use: config.use,
  })
  // Assigned by the assembler, which the core calls after the gate allows the run. They are
  // read by the member closures (`asOfBuild`) and by the reporters (the quarantine set), both
  // of which only ever execute downstream of that call.
  let singleQuarantined: readonly QuarantineAppliedEntry[] = []

  const executor: MemberTestExecutor = async (member, ctx) => {
    const binding = memberBindings[ctx.testIndex]
    if (!binding) {
      throw new Error(`No test-member binding for testIndex ${ctx.testIndex} (testId ${member.testId})`)
    }
    // a member that could not start (its browser never launched, a
    // setup error) fails the run with its cause. It is not a cancel: nobody cancelled the run. The
    // members after it are skipped without launching, and each says which earlier member failed.
    if (frameworkSkipReason !== undefined) {
      return {
        runId: member.testId,
        name: member.name,
        filePath: member.filePath,
        status: 'skipped',
        steps: [],
        duration: 0,
        failureSummary: frameworkSkipReason,
      }
    }
    try {
      return await binding(ctx)
    } catch (err) {
      const { failureSummary } = formatFrameworkError(err instanceof Error ? err.message : String(err))
      if (frameworkError === undefined) {
        frameworkError = err
        frameworkSkipReason = `Not run: "${member.name}" could not start. ${failureSummary}`
      }
      return {
        runId: member.testId,
        name: member.name,
        filePath: member.filePath,
        status: 'failed',
        steps: [],
        duration: 0,
        failureSummary,
      }
    }
  }

  const directPlannerLimits = plannerLimitsRecord(
    resolvePlannerLimits(config.use),
    filtered.map(({ test }, index): MemberPlannerLimits => ({
      testName: test.name,
      filePath: members[index].filePath,
      limits: directPlannerConfigs[index],
    })),
  )

  return {
    members,
    executor,
    configDigests: runDigests.runLevel,
    product: singleRunProduct,
    plannerLimits: directPlannerLimits,
    configDir,
    configFilePath,
    knowledgeRoot: resolveKnowledgeRoot(config.knowledge, configDir),
    memberProbeUrls: directTargetFacts.probeUrls,
    concurrency: resolveRunConcurrencyConfig(
      config.use as Record<string, unknown> | undefined,
      opts,
      filtered.map(({ test }) => test.use as Record<string, unknown> | undefined),
    ),
    ...(singleBuildTag === undefined ? {} : { buildTag: singleBuildTag }),
    logger,
    secretRedactor: runtimeSecrets.secretRedactor,
    applyAssembly: ({ buildOrdinal, quarantined }) => {
      singleBuildOrdinal = buildOrdinal
      singleQuarantined = quarantined
    },
    bindSession: (session) => { activeRunSession = session },
    takeFrameworkError: () => frameworkError,
    getCurationModelDeps: () => singleCurationModelDeps,
    onMemberSnapshot: memberSnapshots.subscribe,
    loadPlugins: input.inputs.loadPlugins,
    ...(config.services?.dashboard?.dbPath === undefined
      ? {}
      : { configuredRunsDbPath: config.services.dashboard.dbPath }),
    runArtifact: stagedRunArtifact(
      directRunSource(filtered),
      filtered.map((binding) => binding.test.target),
      singleRunMask,
    ),
  }
}

export function createRunCommand(): Command {
  const cmd = new Command('run')
    .description('Run test files')
    .argument('[patterns...]', 'glob patterns for test files')
    .option('--browser <name>', 'override browser (chromium, firefox, webkit)')
    .option('--platform <name>', 'filter by platform (web, android, ios)')
    .option(
      '--build-tag <tag>',
      'name the app-under-test build for the buildTag-to-ordinal mapping (env: AGENT_QA_BUILD_TAG; config: use.buildTag)',
    )
    .option('--headless', 'run in headless mode')
    .option('--no-headless', 'run in headed mode')
    .option('--disable-cache', 'bypass action cache for this run')
    .option('--save-cache', 'write cache even on the default/protected branch')
    .option('--dry-run', 'parse and list tests without executing')
    .option('--list-tests', 'list discovered test files without executing')
    .option('--junit-output <path>', 'path for JUnit XML output')
    .option('--screenshot-mode <mode>', 'when to capture: failure (default) or every-step')
    .option('--reporter <names...>', 'select reporters (default: console)')
    .option('--record', 'enable session video recording (services.recording.enabled)')
    .option('--no-record', 'disable session video recording for this run (services.recording.enabled)')
    .option('--config-debug', 'print resolved config with source attribution for each test')
    .option('--test', 'discover and run tests via testMatch patterns (default when no flags)')
    .option('--suite', 'discover and run suites via suiteMatch patterns')
    .option('--all', 'discover and run both tests (testMatch) and suites (suiteMatch)')
    .option('--device <name>', 'Override the mobile test/suite device for this run')
    .option('--var <kv...>', 'set variable KEY=VALUE (repeatable)')
    .option('--run-attr <kv...>', 'attach run attribute KEY=VALUE; repeatable')
    // the session trust flag is gone — nothing asks, so there is nothing to trust
    // past. Commander refuses it as an unknown option.
    .option('--detach', 'skip the post-verdict knowledge curation tail')
    // the config knob's flag half. ORDINARY OVERRIDES — they ride the same
    // `use`-bucket precedence every other flag here does, and there is no request field to match
    // them: a remote caller cannot raise the concurrency of a target its config owner tuned.
    .option('--parallel', 'run this run\'s members concurrently (config: use.parallel)')
    .option('--no-parallel', 'run this run\'s members one at a time')
    .option('--workers <count>', 'ceiling on concurrent members when parallel (config: use.workers; default 3)')
    // Both run markers are flags because a run started through `runs.start` re-enters this command
    // as a child process. They are separate axes, so a caller may set either alone.
    .option('--gate-run', 'mark this run as a gate run: a check of a drafted test before it is shown')
    .option(
      '--excluded-from-outcomes',
      'exclude this run from the outcome projection: no flake counters, no exemplar ranking, no quarantine window',
    )
    .action(async (patterns: string[], opts: RunOptions, command: Command) => {
      // the direct path's record, so the catch can close it.
      let _crashRecord: RunRecord | undefined
      let _crashSecretRedactor: SecretRedactor | undefined
      // the run this invocation started, so a framework error names the id it recorded.
      let _startedRunId: string | undefined

      // 398-15 (WR-06, paired with CR-01): DRAIN THE MEMOISED ANALYTICS HOST BEFORE THIS ACTION
      // EXITS. Declared out here, beside `_crashRecord`, because the third terminal exit is in the
      // CATCH below and a binding inside the `try` is not in scope there.
      //
      // Until CR-01 the transport's flush tore the PostHog client down, so this command's
      // per-session flush was the only thing releasing it; with flush now a flush, an undrained
      // exit leaks a live client with an armed flush timer. ONCE-ONLY: a path that composed nothing
      // is a no-op and a second call cannot happen.
      //
      // A `finally` is not the fix — `process.exit` does not run one — so this is awaited
      // immediately before each of the ACTION's three terminal exits. IT COVERS THOSE THREE AND
      // NOTHING ELSE: the four cancellation exits carried by the two shutdown controllers (this
      // action's own at :3483/:3486 and `executeSuites`' at :1184/:1187) are knowingly NOT drained
      // — they are user-initiated cancels where telemetry loss is the accepted failure direction,
      // and awaiting a drain inside a signal path would trade that for an unbounded Ctrl+C.
      let composedAnalytics: CliAnalyticsHost | undefined
      let analyticsDrained = false
      const drainAnalytics = async (): Promise<void> => {
        if (analyticsDrained || composedAnalytics === undefined) return
        analyticsDrained = true
        await composedAnalytics.shutdown()
      }

      try {
        // ARGV-ONLY VALIDATION STAYS WITH THE DOOR. A `RunsStartInput` has no mode flags to make
        // mutually exclusive, so this refusal is unreachable from every other door and belongs to
        // the one that has an argv. `--list-tests`, `--dry-run`, the suite early return, the two
        // shutdown controllers and the three terminal verdict exits stay here for the same reason:
        // the module owns computation, the door owns process termination.
        const modeFlags = [opts.test, opts.suite, opts.all].filter(Boolean).length
        if (modeFlags > 1) {
          console.error(pc.red('Error: --test, --suite, and --all are mutually exclusive.'))
          process.exit(1)
        }

        const program = command.parent!
        const globalOpts = program.opts<{ config?: string; verbose?: boolean; quiet?: boolean; logLevel?: string }>()

        const flagOverrides: Record<string, unknown> = {}
        if (opts.browser) {
          flagOverrides.browsers = [{ name: opts.browser }]
        }
        if (opts.headless !== undefined) {
          // headless is handled per-platform in platformConfig setup below
        }

        // THE INPUT PREFLIGHT IS A PRODUCER NOW, and this door is one of its callers.
        // Everything it used to do inline — resolve the config, read the raw config bytes, parse
        // `--var`/`--run-attr`, load the secrets store, read the env file, read and validate the
        // hooks file, and discover BOTH halves of the `{ tests, suites }` split — happens in
        // `resolveRunInvocationInputs`, in the same order, producing the same strings. What changed
        // is who terminates: the producer throws a `CliRunInputError` and THIS door prints its
        // `lines` and exits with its `exitCode` (see the action's catch), so a daemon composing the
        // same producer survives a missing `.env` instead of dying on it.
        const inputs = await resolveRunInvocationInputs({
          ...(globalOpts.config === undefined ? {} : { configPath: globalOpts.config }),
          patterns: patterns ?? [],
          ...(opts.suite === true
            ? { mode: 'suite' as const }
            : opts.all === true
              ? { mode: 'all' as const }
              : opts.test === true
                ? { mode: 'test' as const }
                : {}),
          flagOverrides,
          loadAuthPlugins: !(opts.dryRun || opts.listTests),
          // The CLI's own fold: an explicit --log-level beats --verbose/--quiet; the config's
          // setting and the 'warn' fallback are the producer's, shared with every other door.
          ...(() => {
            const doorLevel = globalOpts.logLevel
              ?? (globalOpts.verbose ? 'debug' : undefined)
              ?? (globalOpts.quiet ? 'silent' : undefined)
            return doorLevel === undefined ? {} : { logLevel: doorLevel }
          })(),
          ...(opts.var === undefined ? {} : { varFlags: opts.var }),
          ...(opts.runAttr === undefined ? {} : { runAttrFlags: opts.runAttr }),
          warn: (message) => { printRunText(message, (text) => console.warn(text)) },
        })

        const {
          config,
          configFilePath,
          configDir,
          workspacePaths,
          configContent,
          runtimeSecrets,
          envFileVars,
          rawEnvFileContent,
          resolvedEnvFilePath,
          resolvedHooks,
          sandboxOptions,
          effectiveLogLevel,
          cliVars,
          inlineVars,
          userRunAttributes,
        } = inputs
        _crashSecretRedactor = runtimeSecrets.secretRedactor
        let discoveredTestFiles: string[] = [...inputs.discovered.tests]
        const discoveredSuiteFiles: string[] = [...inputs.discovered.suites]

        // THIS COMMAND'S ANALYTICS COMPOSITION ROOT. One decision, one
        // identity, one port for the whole invocation — including a `--all` run that drives the
        // suite path and then the direct path, which shared a process-global service in v1 and
        // shares a memoised object now.
        //
        // MEMOISED RATHER THAN EAGER. `--list-tests`, `--dry-run` and every validation-only path
        // return without starting a run, and composing would resolve the identity store — writing
        // `~/.agent-qa/analytics.json` on a machine that has none — for an invocation that emits
        // nothing. The first attach site pays for it; there is never a second.
        // `composedAnalytics` and its once-only drain are declared above the `try`.
        const analytics = async (): Promise<CliAnalyticsHost> => (
          composedAnalytics ??= await composeAnalyticsHost({ surface: 'cli', config })
        )

        // Handle suite execution (early return)
        if (discoveredSuiteFiles.length > 0 && discoveredTestFiles.length === 0) {
          const exitCode = await executeSuites(discoveredSuiteFiles, opts, config, globalOpts, configContent, effectiveLogLevel, { envFileVars, inlineVars, cliVars, rawEnvFileContent, resolvedEnvFilePath, userRunAttributes, ...runtimeSecrets }, resolvedHooks && sandboxOptions ? { resolvedHooks, sandboxOptions } : undefined, analytics, inputs.loadPlugins)
          const suiteReporterSelection = resolveReporterSelection(opts).selection
          if (suiteReporterSelection) {
            await maybePrintPostRunUpdateNotice({
              reporterSelection: suiteReporterSelection,
              effectiveLogLevel,
              liveEvents: process.env.AGENT_QA_LIVE_EVENTS,
              cwd: process.cwd(),
            })
          }
          await drainAnalytics() // terminal exit 1 of 3 — the suite-only path.
          process.exit(exitCode)
        }

        // Handle --all: run suites first, then fall through to test execution
        let suitesFailed = false
        if (discoveredSuiteFiles.length > 0 && discoveredTestFiles.length > 0) {
          suitesFailed = (await executeSuites(discoveredSuiteFiles, opts, config, globalOpts, configContent, effectiveLogLevel, { envFileVars, inlineVars, cliVars, rawEnvFileContent, resolvedEnvFilePath, userRunAttributes, ...runtimeSecrets }, resolvedHooks && sandboxOptions ? { resolvedHooks, sandboxOptions } : undefined, analytics, inputs.loadPlugins)) !== 0
        }

        const files = discoveredTestFiles

        if (opts.listTests) {
          console.log(pc.bold(`\nDiscovered ${files.length} test file(s):\n`))
          if (files.length > 0) {
            printRunText(files.map((file) => `  ${file}`).join('\n'), (text) => console.log(text))
          }
          process.exit(0)
        }

        const { parseAllTestBindings, formatParseError } = await import('@vostride/agent-qa-core')
        const parseResult = await parseAllTestBindings(files)
        const directRunProduct = parseResult.errors.length === 0
          ? requireSingleInvocationProduct(parseResult.bindings.flatMap(({ test }) => {
              if (test.target === undefined) return []
              return [{
                label: `test ${test.name}`,
                product: resolveTarget(config, test.target).product,
              }]
            }))
          : undefined

        const reporterSelection = requireReporterSelection(opts)
        let currentRunId: string | undefined
        // one record for this path, written whatever the config holds.
        const record = createRunRecord({
          attributes: buildCliRunAttributes(userRunAttributes, 'local'),
          warn: (line) => printRunText(pc.yellow(line), (text) => console.warn(text)),
        })
        _crashRecord = record
        const configuredRunsDbPath = config.services?.dashboard?.dbPath

        if (parseResult.errors.length > 0) {
          printRunText(
            [
              pc.red(`Found ${parseResult.errors.length} parse error(s):\n`),
              ...parseResult.errors.map((err) => formatParseError(err)),
            ].join('\n'),
            (text) => console.error(text),
          )
          const validationRunId = createTestRunId()
          const validationAttributes = buildCliRunAttributes(userRunAttributes, 'local')
          // the failure row is filed under the id this command prints.
          await record.open({
            runId: validationRunId,
            configDir,
            ...(configuredRunsDbPath === undefined ? {} : { configuredDbPath: configuredRunsDbPath }),
          })
          const dashboardDb = record.db
          if (dashboardDb) {
            const now = new Date().toISOString()
            const { basename } = await import('node:path')
            const errorText = parseResult.errors.map(e => formatParseError(e)).join('\n').replace(/\x1b\[[0-9;]*m/g, '')
            const { readFileSync } = await import('node:fs')
            const rawContent = readFileSync(files[0], 'utf-8')
            const nameMatch = rawContent.match(/^\s*name:\s*(.+)$/m)
            const targetMatch = rawContent.match(/^\s*target:\s*(.+)$/m)
            let detectedPlatform = 'web'
            if (targetMatch) {
              const targetName = targetMatch[1].trim()
              const resolvedTarget = (config as any).registry?.targets?.[targetName]
              if (resolvedTarget?.platform) detectedPlatform = resolvedTarget.platform
            }
            const testName = nameMatch ? nameMatch[1].trim().replace(/^['"]|['"]$/g, '') : basename(files[0], '.yaml')
            dashboardDb.insertRun({
              id: validationRunId,
              name: testName,
              status: 'failed',
              duration: 0,
              startedAt: now,
              endedAt: now,
              attributes: validationAttributes,
              platform: detectedPlatform,
              failureSummary: `${parseResult.errors.length} parse error(s)`,
            })
            dashboardDb.updateRun(validationRunId, { errorLog: errorText })
            dashboardDb.insertRunArtifact({
              runId: validationRunId,
              kind: 'test',
              payload: redactSecretValue({
                config: {
                  rawConfigContent: configContent,
                  parsedConfig: config,
                  effectiveConfig: config,
                  envFile: { path: resolvedEnvFilePath, content: rawEnvFileContent, variables: envFileVars },
                  secretsFile: runtimeSecrets.secretsFileMetadata,
                  cliVars,
                  inlineVars,
                  hooks: buildHooksArtifact(resolvedHooks),
                },
                source: {
                  kind: 'test',
                  testId: null,
                  name: testName,
                  filePath: files[0],
                  rawYaml: rawContent,
                  resolvedDefinition: null,
                  loadStatus: 'parse-error',
                },
                runtime: {
                  platform: detectedPlatform,
                  targetName: targetMatch ? targetMatch[1].trim() : null,
                },
                metadata: { attributes: validationAttributes },
                errors: parseResult.errors.map((error) => ({
                  code: 'parse-error',
                  phase: 'parse',
                  message: error.message,
                  details: error,
                })),
              }, runtimeSecrets.secretRedactor),
            })
            dashboardDb.finalizeRunArtifact(validationRunId)
          }
          record.close()
          printRunId(validationRunId)
          printRunAttributes(validationAttributes)
          process.exit(2)
        }

        const filtered = parseResult.bindings

        // `filtered` is `parseResult.bindings` verbatim — no grep/filter narrows it here — so
        // `filtered.length === 0` means discovery RESOLVED >=1 test file (the exit-2 guards above
        // already proved that) but parsing produced ZERO runnable tests. Starting a run from here
        // would assemble a zero-member RunSession and render a benign-looking "Tests: 0 of 0 passed"
        // summary (console-reporter printStandaloneSummary) — a silent green non-run. An existing
        // resolved target must instead FAIL LOUDLY (exit 2, the same config/usage contract as the
        // "no files found" guards), never a silent empty run. (T-365-04b)
        refuseZeroRunnableTests(files, filtered)

        if (opts.dryRun) {
          console.log(pc.bold(`\nFound ${filtered.length} test(s):\n`))
          for (const { test } of filtered) {
            const lines = [`  ${pc.green('●')} ${test.name}`]
            if (opts.configDebug) {
              lines.push(
                pc.bold(`\n  Config for: ${test.name}`),
                formatConfigDebug(
                  config,
                  test.use,
                  flagOverrides,
                  (text) => runtimeSecrets.secretRedactor.redactString(text),
                ),
                '',
              )
            }
            printRunText(lines.join('\n'), (text) => console.log(text))
          }
          process.exit(0)
        }

        // ---- Compose the one RunSession per invocation ---------------------------------------------
        // Each discovered test file is a member of one RunSession. Members carry no failFastGroup,
        // so every member runs and the run then aggregates. The run-level SIGINT routes into
        // session.cancel(), and the verdict map owns the exit code.
        let shutdownRequested = false
        let frozenExitCode: number | undefined
        let activeRunSession: { cancel(): void } | undefined
        const curationAbortController = new AbortController()
        // A throw out of a member closure is a framework/setup error (not a test failure): the shell
        // absorbs executor throws into failed members (D-13, never crashes the run), so the producer
        // captures the first one, fails that member with its cause, skips the members after it
        // (433-35: never a cancel), and re-surfaces it after `done` to preserve the exit-2 contract.
        let frameworkError: unknown | undefined
        // SESSION-04 force-exit backstop (Plan 361-13 Task 3): armed on cancel, cleared after
        // `await session.done` (and BEFORE any frameworkError re-throw so the exit-2 contract holds).
        let graceTimer: ReturnType<typeof setTimeout> | undefined
        const clearGraceTimer = (): void => {
          if (graceTimer) clearTimeout(graceTimer)
          graceTimer = undefined
        }
        // RUNX-02 / D1: route both signals through the controller so a SECOND Ctrl+C HARD force-exits
        // (130) immediately, independent of the grace timer and of any wedged async `done`. The
        // grace-timer arming/unref/clear stays inline here so the 361-13 backstop anchors hold.
        const forceExit = (code: number): never => {
          closeOwnRowAtForcedExit(record)
          process.exit(code)
        }
        const shutdownController = createShutdownController({
          cancel: () => {
            curationAbortController.abort()
            try { activeRunSession?.cancel() } catch { /* cancel is best-effort */ }
          },
          exit: forceExit,
          setExitCode: (code) => { shutdownRequested = true; process.exitCode = frozenExitCode ?? code },
          armGrace: () => {
            if (frozenExitCode !== undefined) return
            const grace = setTimeout(() => forceExit(130), cancelGraceMs())
            grace.unref?.()
            graceTimer = grace
          },
        })
        // `on`, not `once`, so a repeated Ctrl+C reaches the controller's hard force-exit path.
        process.on('SIGINT', shutdownController.handleSignal)
        process.on('SIGTERM', shutdownController.handleSignal)
        process.on('SIGHUP', shutdownController.handleSignal)


        // ONE members/executor assembly on this door, and this path is a
        // CALLER of it rather than its only owner. The member closure, the descriptors, the digest
        // mint, the declared target class, the probe URL and the executor wrapper all live in
        // `produceDirectRunMembers` now — the SAME producer a door holding nothing but a
        // `RunsStartInput` reaches through `produceMembersFromPatterns`. Two copies of this chain
        // would be two answers to what a member of this run is.
        // decided once, before the members exist, and handed to the producer,
        // the dashboard ingest and the drive alike.
        const singleRunId = process.env.AGENT_QA_RUN_ID ?? generateRunId()

        const produced = await produceDirectRunMembers({
          inputs,
          bindings: filtered,
          runId: singleRunId,
          ...(directRunProduct === undefined ? {} : { product: directRunProduct }),
          opts,
          analytics,
          onMemberRunId: (memberRunId) => { currentRunId = memberRunId },
          terminal: RUN_TERMINAL,
          hostOwnsSignals: true,
        })
        printPlannerLimits(produced.plannerLimits)
        const members = produced.members
        const executor = produced.executor
        const logger = produced.logger
        const singleRunProduct = produced.product
        const singleBuildTag = produced.buildTag
        const runDigests = { runLevel: produced.configDigests }
        let singleQuarantined: readonly QuarantineAppliedEntry[] = []

        // The verdict map stays a door concern until task 3 hands the whole drive over.
        const { mapVerdictToExitCode } = await import('@vostride/agent-qa-runner')

        const singleExecutionContext = resolveRunExecutionContext()

        // THE SINGLE-TEST PATH IS A CALLER OF THE ONE IN-PROCESS DRIVE.
        //
        // What used to be an inline `startRun`, then an inline `createRunInvocationCore`, is now a
        // call. The drive owns the ORDER and the run-scoped machinery every door needs identically —
        // the ONE audit sink, the safety-hook runner, the safety scope, the
        // assembler hand-off and the verdict map. This door supplies what only a door can answer: its
        // TTY posture, its members, its reporters, and what to do after the verdict. (432-13: no
        // trust flag and no confirm channel — nothing asks.)
        //
        // WHAT STAYS HERE, DELIBERATELY: signal registration and the grace timer, `activeRunSession`
        // (through `onSession`), the reporters and their flush ordering, `releaseAppium()`, closing
        // the dashboard db, the curation tail, the `--all` exit-code fold and the three terminal
        // exits. A drive that reached for any of those would be a library that owns its host.
        const singleExtraSubscribers: RunSubscriberHandle[] = []
        // same factory, same composed port — Pitfall 8's rule applied to analytics.
        const singleAnalytics = await analytics()
        singleExtraSubscribers.push(buildAnalyticsRunSubscriber({
          analytics: singleAnalytics,
          ...analyticsRunAttribution(buildCliRunAttributes(userRunAttributes, 'local')),
        }))

        const { runInProcessCliRun } = await import('../composition/in-process-run-execution.js')
        let singleExit: number
        try {
          const outcome = await (runInProcessCliRun as typeof RunInProcessCliRun)(
            {
              configPath: configFilePath,
              agentQaRoot: resolvePath(configDir, '.agent-qa'),
              executionContext: singleExecutionContext,
              inputs,
              // The members this door already produced. The SAME producer a bare-request door
              // reaches through `produceMembersFromPatterns` — handed over rather than re-run,
              // because this door needed them for `--list-tests`, `--dry-run` and its parse-error
              // report before it could get here.
              produceMembers: async () => produced,
              // what the shell's post-verdict step should do about POST-PROCESSING for this
              // run. `--detach` asks this process not to SPEND itself on the chain, so it skips the LEASE —
              // never the enqueue, which the step performs either way (RESEARCH Pitfall 8). The literal-only
              // spread is the same house rule the INVK-06 markers ride: an absent flag is an ABSENT field.
              postProcessing: { ...(opts.detach === true ? { detach: true as const } : {}) },
              runRecord: record,
              onSession: (session) => {
                activeRunSession = session
                _startedRunId = singleRunId
                logger?.setRunId(singleRunId)
              },
              subscribers: ({ session, quarantined, mask }) => {
                singleAnalytics.bindMaskingContext({ mask })
                // Attach the bus subscribers (console, junit and wire print masked payloads;
                // analytics) — replay-then-live gives D-04 for free. The drive attaches the record.
                // `quarantined` is the SAME resolved set the run was assembled with (390 D-15,
                // Pitfall 8).
                return attachRunSubscribers({
                  session,
                  console: reporterSelection.console ? { verbose: false, logLevel: effectiveLogLevel } : false,
                  junitOutputPath: reporterSelection.junit ? opts.junitOutput : undefined,
                  extraSubscribers: singleExtraSubscribers,
                  quarantined,
                })
              },
              warn: (message) =>
                printRunText(pc.yellow(`  Quarantine: ${message}`), (text) => console.warn(text)),
              // The post-verdict tail, run INSIDE the run's own safety scope so its curation egress
              // masks like every other. The `--all` fold happens on the freeze line below and is
              // untouched by this rework.
              postVerdictSignal: curationAbortController.signal,
              freezeVerdict: (verdict) => {
                clearGraceTimer()
                activeRunSession = undefined
                // Include cancellation observed during execution and the earlier --all suite fold.
                // A later first signal only aborts preparation/tail waiting; a second still exits.
                const verdictExitCode = mapVerdictToExitCode(
                  shutdownRequested ? 'cancelled' : (verdict as never),
                )
                frozenExitCode =
                  verdictExitCode !== 0 ? verdictExitCode : (suitesFailed ? 1 : 0)
                return frozenExitCode
              },
              afterVerdict: async ({ exitCode, mask, postVerdict, postVerdictDeadlineMs }) => {
                // the same shared tail as the multi-suite site above, and the same 404
                // D-05 posture — the enqueue happened in the shell, so this handle has two legs.
                const postRunTail = composeCliPostRunTail({
                  postVerdict,
                  ...(postVerdictDeadlineMs === undefined ? {} : { deadlineMs: postVerdictDeadlineMs }),
                  runId: singleRunId,
                  configDir,
                  configFilePath,
                  knowledgeConfig: config.knowledge,
                  mask,
                  ...(produced.getCurationModelDeps() === undefined
                    ? {}
                    : { modelDeps: produced.getCurationModelDeps()! }),
                  signal: curationAbortController.signal,
                  log: curationTailLog,
                  executionContext: singleExecutionContext,
                })
                return await runVerdictFirstCurationTail({
                  exitCode,
                  detach: opts.detach === true,
                  // the same one-lease rule, and the same take-inside-`drain()`
                  // thunk, as the multi-suite site above.
                  runTail: () => postRunTail.drain({
                    takeLease: () => postVerdict.takeAcquiredLease(),
                  }),
                  // the close-out line runs on BOTH paths, --detach included.
                  finish: (input) => postRunTail.finish(input),
                  onUnexpectedError: () => {
                    curationTailLog.warn(unexpectedCurationTailWarning(singleExecutionContext))
                  },
                })
              },
            },
            {
              runId: asRunId(singleRunId),
              ...runMarkers(opts),
            },
          )
          singleExit = outcome.exitCode
        } finally {
          // Keep both process signals live through the drain, then release them. The masking
          // context is disposed inside the drive, absolutely last within the run's own scope.
          clearGraceTimer()
          shutdownController.dispose()
          process.removeListener('SIGINT', shutdownController.handleSignal)
          process.removeListener('SIGTERM', shutdownController.handleSignal)
          process.removeListener('SIGHUP', shutdownController.handleSignal)
        }

        releaseAppium()

        record.close()

        // `singleExit` was fixed from the verdict plus any --all suite failure before curation.
        const exitCode = singleExit
        await maybePrintPostRunUpdateNotice({
          reporterSelection,
          effectiveLogLevel,
          liveEvents: process.env.AGENT_QA_LIVE_EVENTS,
          cwd: process.cwd(),
        })
        await drainAnalytics() // terminal exit 2 of 3 — the verdict path.
        process.exit(exitCode)
      } catch (err) {
        // AN INPUT REFUSAL, RENDERED BY THE DOOR THAT HAS A TERMINAL.
        //
        // Every input failure on the in-process path — a missing `.env`, an unreadable hooks file,
        // a secrets file that is not there, a pattern that matched nothing, a file that parsed to
        // zero runnable tests — used to render and call `process.exit` where it was discovered.
        // They are typed throws now, and this is the ONE place the command turns one back into
        // rendered output and an exit code. The bytes and the code are the ones the discovery site
        // used to print, so the door's observable behaviour is unchanged; what changed is that a
        // daemon composing the same producer no longer dies on a config typo.
        //
        if (err instanceof CliRunInputError) {
          if (err.lines.length > 0) {
            printRunText(err.lines.join('\n'), (text) => console.error(text))
          }
          process.exit(err.exitCode)
        }
        // THE IDENTITY REFUSALS ARE DECISIONS, AND ARE DESCRIBED AS ONES. Measured
        // before this branch existed: `AGENT_QA_RUN_ID=not-a-minted-id agent-qa run …` printed
        // `Framework error: agent-qa cannot start a run under "not-a-minted-id"` — a refusal
        // rendered as a crash, which is the exact defect 401-18 closed at the dashboard's read
        // path ("a refusal is carried as a fact and described as one"). Nothing ran, nothing
        // failed, and the message the core minted is already the whole answer: the caller named an
        // id it may not name, and no remedy vocabulary is involved because no policy was consulted.
        //
        // EXIT 2, NOT 1: `1` is "the tests failed", and nothing ran. `2` is this command's existing
        // "no verdict was produced" code.
        if (err instanceof RunIdNotMintedError || err instanceof RunIdAlreadyInUseError) {
          printRunText(
            pc.red(redactSecretValue(err.message, _crashSecretRedactor)),
            (text) => console.error(text),
          )
          await drainAnalytics()
          process.exit(2)
        }
        // a run this command cannot record is refused, exit 2, no id.
        if (err instanceof RunRecordUnavailableError) {
          printRunText(
            pc.red(redactSecretValue(err.message, _crashSecretRedactor)),
            (text) => console.error(text),
          )
          await drainAnalytics()
          process.exit(2)
        }
        const errMsg = err instanceof Error ? err.message : String(err)
        printRunText(
          pc.red(frameworkErrorTerminalLine(errMsg, _crashSecretRedactor)),
          (text) => console.error(text),
        )

        // no cause is guessed and no row is written here; the record's
        // flush already closed a verdictless own row.
        // The run already recorded its verdict and the cause, so the id is how to read it.
        if (_startedRunId !== undefined) printRunId(_startedRunId)

        try { _crashRecord?.close() } catch {}
        await drainAnalytics() // terminal exit 3 of 3 — the action's error path.
        process.exit(2)
      }
    })

  return cmd
}
