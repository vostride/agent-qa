import { GATE2_DEFAULT_MAX_LOWER_TRUST_PER_SCOPE } from '@vostride/agent-qa-schema'
import { resolveKnowledgeRoot } from '@vostride/agent-qa-core'
// The CLI composition-root sibling for the eval verbs (Phase 372, Plan 04 — the D-05 sibling of
// the run session composition, which as of 385-08/D-13 is the local agent package's composition
// subtree rather than a module beside this one). It discharges at ONE site what every eval verb (replay / score /
// report / seed; plans 372-05/06/07) stands on: the session's `mask`, a SecretRedactor over the
// workspace secrets file and nothing else (441 D-01/D-06); and D-03
// judge-as-named-user-facing-config — judge/planner resolution flows through the exact
// resolveNamedConfig → resolveModelAuth → toModelProfileAndAuth chain run uses, discharging
// 370 D-06's explicit-second-ModelProfile contract. Errors are typed (D-08): the command layer
// maps them to exit codes — never process.exit inside this module.
//
// The CLI is a surface / composition root with full host access (spec §4), so this module uses
// node builtins directly.

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  HANDOFF_FILE,
  RUNS_SUBDIR,
  loadCompletedRunHandoff,
  slugBranch,
} from '@vostride/agent-qa-runner-local'
import {
  assertBaselineComparator,
  buildEvalReport,
  buildSeedingPlan,
  admitSeedMember,
  canonicalJson,
  composeBaselineProfileKey,
  computeBatchKey,
  computeCorpusDigest,
  createPanelIdentity,
  decisionCorrectnessVectors,
  deriveCensus,
  renderCensusMarkdown,
  EXCLUSION_CLASSES,
  extractRunCassettes,
  FLOOR_PROTOCOL_MINIMUM,
  guardClassifierRepeatability,
  guardCampaignManifest,
  JUDGE_CONFIG,
  judgeIdentitySchema,
  maskCorpusText,
  partitionParamsOf,
  projectBaselinePointer,
  projectDecisionVectorsDocument,
  projectPartitionManifest,
  projectRunExclusion,
  renderBaselineComparatorRefusal,
  renderFloorRefusal,
  resolveJudgeFamily,
  resolveProductPartition,
  SEED_POLICIES,
} from '@vostride/agent-qa-eval'
import type {
  AuthoringModel,
  BaselineComparatorRefusal,
  ClassifierRepeatability,
  CassetteScore,
  CorpusCensus,
  DecisionScoreEntry,
  DeriveCensusInput,
  EvalBatchReport,
  ExclusionClass,
  JudgeIdentityBlock,
  NoProbeModelGap,
  PartitionManifest,
  ProbeAuthorPort,
  SeedPolicy,
  ScoredBatchEntry,
  SilverExclusion,
  TargetEnvironment,
} from '@vostride/agent-qa-eval'
// TYPE-ONLY, and deliberately so: `adversarial-probe-preflight.ts` and
// `adversarial-probe-author.ts` reach their pure contracts THROUGH this composition boundary
// (422-05), so a value import here would be a runtime cycle. The verb imports the two functions
// dynamically at call time, the same way the command layer imports this module.
import type {
  AdversarialProbeAuthorSelection,
  AdversarialProbeCapability,
} from './adversarial-probe-preflight.js'
import type { ProbeCallAttempt } from './adversarial-probe-author.js'
import {
  COMMITTED_CASSETTES_DIR,
  DEFAULT_EVAL_CASSETTES_SUBDIR,
  DEFAULT_EVAL_REPLAYS_SUBDIR,
  DEFAULT_EVAL_REPORTS_SUBDIR,
  FloorProtocolError,
  FsCassetteStore,
  FsReplayRecordStore,
  FsReportStore,
  readReportProfileProof,
  FsRunArtifactSource,
  FsScoreStore,
  assembleScoredBatch,
  copyJudgeCalibrationToReport,
  readJudgeCalibration,
  admitStagedFeedback,
  ADVERSARIAL_STAGING_SUBDIR,
  listStagedAdversarial,
  refreshAdversarialSplit,
  retireStagedAdversarialBatch,
  resolveAdversarialProbeCallCap,
  resolveAdversarialSeedCap,
  stageAdversarialProposal,
  FEEDBACK_STAGING_SUBDIR,
  readCommittedCorpusDigest,
  readProbeAttempt,
  cassetteProductPartition,
  commitCensus,
  commitEvalReport,
  committedExclusionPath,
  committedNoiseFloorPath,
  committedPartitionManifestPath,
  computeReplayProfileFingerprintFor,
  listBaselinePointers,
  listCommittedReports,
  listNoiseFloorArtefacts,
  loadCassetteBundles,
  loadLabelEvidence,
  loadReplayRecord,
  loadScoreRecord,
  readCommittedCorpus,
  readActiveCommittedCorpus,
  readPartitionManifests,
  readRunExclusions,
  replayJudgeRequest,
  runNoiseFloorMeasurement,
  runReleaseGate,
  runLabelCalibration,
  runJudgeCalibration,
  maskJudgeCalibrationText,
  seedCommittedCorpus,
  sweepCassetteReplays,
  writeBaselinePointer,
  writePartitionManifest,
  writeRunExclusion,
} from '@vostride/agent-qa-eval-local'
import type {
  AdversarialProbeCallCap,
  AdversarialProbeRefusal,
  AdversarialProbeSkip,
  AdversarialRefusal,
  AdversarialSeedCap,
  AdversarialSpend,
  AdversarialStagingSkip,
  StageAdversarialProposalResult,
  StagedAdversarialCase,
  CommitCensusOutcome,
  CommitEvalReportOutcome,
  ReleaseGateMode,
  RunNoiseFloorMeasurementResult,
  RunReleaseGateResult,
  RunLabelCalibrationResult,
  SeedingRefusal,
  WriteBaselinePointerOutcome,
} from '@vostride/agent-qa-eval-local'
import { runSafetyScope } from '@vostride/agent-qa-safety-local'
import type {
  ModelProfile,
  ModelProviderOverrides,
  ResolvedModelAuth,
} from '@vostride/agent-qa-model'
import {
  ANALYSIS_FILE,
  admitAnalysisArtifactForRun,
  guardRunAnalysisArtifact,
  resolveRunVerdicts,
  sha256hex,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  MaskFn,
  RunAnalysisArtifact,
  Verdict,
} from '@vostride/agent-qa-schema'
import type { SecretStore } from '@vostride/agent-qa-runner'
import type { AgentQaConfig } from '@vostride/agent-qa-core'
import { loadConfigFile, resolveConfig } from './config.js'
import { createDeclaredSecretMask } from './composition/declared-secrets.js'
import { listTargets, resolveTarget } from './targets.js'
export { renderCensusMarkdown }
import { renderEvalReportMarkdown } from './eval-report-render.js'
import {
  LOCAL_CURATION_CAPABILITIES,
  resolveRunExecutionContext,
} from '@vostride/agent-qa-agent-local'
import type { RunExecutionContext } from '@vostride/agent-qa-agent-local'

// The @vostride/agent-qa-eval-local workspace edge (G5) is anchored by the real store/loader
// value imports above (372-05/06); this type re-export stays for the report verb plan (372-07)
// that consumes record loads. Erased at build — no runtime coupling.
export type { ReplayRecordLoad } from '@vostride/agent-qa-eval-local'

// FUNC-02 surface firewall (Phase 384 D-01/D-03): this composition root is the ledgered edge to
// `@vostride/agent-qa-eval`, and the ledger only ever SHRINKS — a surface file written after
// 2026-07-28 may not join it. The census renderer beside this module is such a file, so it types
// against the census DTO through the composition root rather than minting a second edge of its
// own, exactly as `commands/eval.ts` types against the verb DTOs. Type-only, erased at build.
export type {
  // 422 D-05/D-08: the committed adversarial generation mix reaches the console through this
  // same ledgered root, so the census summary can print it without minting a second edge.
  AdversarialGenerationMix,
  BaselineComparatorRefusal,
  CensusCrossCheckLine,
  CorpusCensus,
  ExclusionCensusBlock,
  PartitionCensusBlock,
} from '@vostride/agent-qa-eval'

// 413-06 D-20: the ONE refusal renderer, re-exported so `commands/eval.ts` can print a refused
// baseline designation WITHOUT minting a second surface-firewall edge of its own — the command
// layer receives it through this ledgered root exactly as it receives the verb pipelines.
export { renderBaselineComparatorRefusal, SEED_POLICIES } from '@vostride/agent-qa-eval'
export type { SeedPolicy } from '@vostride/agent-qa-eval'
export type { WriteBaselinePointerOutcome } from '@vostride/agent-qa-eval-local'

// 416: the posture builder obtains eval capabilities through this existing host edge.
// Keep the surface firewall self-shrinking; new CLI files do not gain eval imports.
export { computeCorpusDigest, selectGateSet } from '@vostride/agent-qa-eval'
export type { JudgeCapabilityInput } from '@vostride/agent-qa-eval'
export { judgeCapabilityOf } from '@vostride/agent-qa-eval'
export { readActiveCommittedCorpus, readCommittedCorpus, readGatePostureFor, resolveMinimumGateSet } from '@vostride/agent-qa-eval-local'

/** The user-facing eval params (config `eval:` block merged with per-invocation flags, D-03). */
export interface EvalCliConfig {
  judge?: string
  judges?: readonly string[]
  /** Owner override of D-10 (2026-07-12): explicit default-off same-family judging opt-in. */
  judgeAllowSameFamily?: boolean
  k?: number
  seed?: number
  seeding?: { silverPerTestCap?: number }
  /**
   * 422-09: the schema's OWN block by indexed access, on the `gate2`/`adversarial` idiom beside
   * it. It was a restatement — `{ maxScreens?: number }` — and 422-08's `maxPerJob` landed in the
   * schema without landing here, so the config accepted a bound no reader could ever see. A
   * restatement of a shape with one owner is a second place for it to drift, and this is what
   * that drift costs.
   */
  gate1?: NonNullable<AgentQaConfig['eval']>['gate1']
  gate2?: NonNullable<AgentQaConfig['eval']>['gate2']
  /** 422 D-04: the per-refresh novel-seed cap for `eval adversarial`. */
  adversarial?: NonNullable<AgentQaConfig['eval']>['adversarial']
}

/** The one resolved session every eval verb consumes (D-05). */
export interface EvalSessionFlags {
  judge?: string | readonly string[]
  k?: number
  seed?: number
  silverCap?: number
}

export class EvalJudgeDeclarationError extends TypeError {
  constructor(message: string) { super(message); this.name = 'EvalJudgeDeclarationError' }
}

export { preflightJudgePanel } from './judge-panel-preflight.js'
import { preflightJudgePanel } from './judge-panel-preflight.js'
export type { JudgePanelPreflightDeps, JudgePanelPreflightResult } from './judge-panel-preflight.js'
// Preflight consumes pure contracts through this existing surface composition boundary.
export { createPanelIdentity }
export type { JudgeIdentityBlock, ModelProfile, ResolvedModelAuth }
export {
  assessPanelEligibility, judgeFamiliesIntersect, resolveJudgeFamilies,
  resolveJudgeCalibrationMinimum,
} from '@vostride/agent-qa-eval'
export type {
  JudgeCalibrationEntryDiagnostic, JudgeCalibrationGapReason, JudgeCalibrationMinimum,
} from '@vostride/agent-qa-eval'

/** Validate the whole declaration before overrides; aliases retain multiplicity and order. */
export function selectedEvalJudgeNames(config: Pick<EvalCliConfig, 'judge' | 'judges'>): readonly string[] {
  if (config.judge !== undefined && config.judges !== undefined) {
    throw new EvalJudgeDeclarationError('Set either eval.judge or eval.judges, never both; remove one declaration.')
  }
  if (config.judge !== undefined && typeof config.judge !== 'string') {
    throw new EvalJudgeDeclarationError('eval.judge must be one nonempty registry name; use eval.judges for a list.')
  }
  const names = config.judge !== undefined ? [config.judge] : config.judges === undefined ? [] : config.judges
  if (!Array.isArray(names) || Array.from(names).some(name => typeof name !== 'string' || name.trim().length === 0)) {
    throw new EvalJudgeDeclarationError('eval.judges must be an array of nonempty registry names.')
  }
  if (names.length > JUDGE_CONFIG.maxPanelMembers) {
    throw new EvalJudgeDeclarationError(`Choose at most ${JUDGE_CONFIG.maxPanelMembers} explicit judge names.`)
  }
  return [...names]
}

function withJudgeOverrides(
  judge: import('@vostride/agent-qa-eval-local').RunCassetteReplayInput['judge'],
  modelOverrides?: ModelProviderOverrides,
): import('@vostride/agent-qa-eval-local').RunCassetteReplayInput['judge'] {
  if (judge === undefined || modelOverrides === undefined) return judge
  return 'members' in judge ? { ...judge, members: judge.members.map(member => ({ ...member, modelOverrides })) }
    : { ...judge, modelOverrides }
}

export interface EvalSession {
  config: AgentQaConfig
  configPath: string
  configDir: string
  evalConfig: EvalCliConfig
  /** Every declared secrets-file value as `[secret:<name>]`; a key-only session's mask throws. */
  mask: MaskFn
  executionContext: RunExecutionContext
}

/**
 * Resolve the one eval session (D-05). Validates the config through resolveConfig (which now
 * carries the typed `eval` block), loads the workspace secrets file into a SecretStore, merges
 * flag overrides over the config eval block (flags win field-wise, D-03), and masks with the
 * declared secrets alone. Config errors are typed Errors naming the offending path (D-08) —
 * never process.exit.
 */
export async function resolveEvalSession(input: {
  configPath?: string
  flags?: EvalSessionFlags
  /** Declaration-only host probes read no secrets file, so their session cannot mask. */
  keyOnly?: boolean
} = {}): Promise<EvalSession> {
  const configPath = input.configPath ?? 'agent-qa.config.yaml'
  const configDir = dirname(resolve(configPath))
  const raw = await loadConfigFile(configPath) as { eval?: EvalCliConfig } | null
  if (raw?.eval && typeof raw.eval === 'object') selectedEvalJudgeNames(raw.eval)
  const config = await resolveConfig({ configPath, loadAuthPlugins: input.keyOnly !== true })
  const evalConfig = mergeEvalConfig(config.eval, input.flags)

  if (input.keyOnly === true) {
    return {
      config, configPath, configDir,
      evalConfig,
      mask: () => { throw new Error('A key-only eval session has no declared secrets to mask with') },
      executionContext: resolveRunExecutionContext(),
    }
  }

  const secretStore = await loadEvalSecretStore(config, configDir)
  const { SecretRedactor } = await import('@vostride/agent-qa-runner')
  const redactor = new SecretRedactor(secretStore)

  return {
    config,
    configPath,
    configDir,
    evalConfig,
    mask: (text) => redactor.redactString(text),
    executionContext: resolveRunExecutionContext(),
  }
}

// 441 GAP3-D1: every write into the committed eval corpus masks with the workspace's declared
// secrets, read from the config even for a key-only session (whose own `mask` throws by design).
// A missing secrets file throws DeclaredSecretsUnavailableError, so the write fails closed.
function committedCorpusMask(session: EvalSession): MaskFn {
  const declared = createDeclaredSecretMask(session.configPath)
  declared.redactor()
  return declared.mask
}

/**
 * Typed named-input-not-found rejection (D-08): a `--run <slug>` or `--cassette <id>` naming
 * nothing on disk is the ONLY sweep-shape failure — the command layer maps it to exit 1.
 * Per-item load failures inside a sweep are DATA (`runsSkipped` / `loadRefusals`), never errors.
 */
export class EvalNamedInputError extends Error {
  readonly inputKind: string
  readonly inputName: string
  readonly searchRoot: string

  constructor(
    inputKind: string, inputName: string, searchRoot: string, verb = 'extract', detail?: string,
  ) {
    super(
      detail === undefined
        ? `No recorded ${inputKind} named "${inputName}" under ${searchRoot} — nothing to ${verb}.`
        : `Cannot ${verb} ${inputKind} "${inputName}" at ${searchRoot}: ${detail}`,
    )
    this.name = 'EvalNamedInputError'
    this.inputKind = inputKind
    this.inputName = inputName
    this.searchRoot = searchRoot
  }
}

/** The extract verb's one DTO — the console renders FROM this, never around it (D-04). */
export interface ExtractVerbResult {
  /** Run dirs (with a handoff document) that entered the sweep after `--run` narrowing. */
  runsSwept: number
  /** Per-run typed skips: unreadable / version-refused handoffs (D-02, never batch errors). */
  runsSkipped: { runSlug: string; reason: string }[]
  /** Runs whose product partition differed from `--product`. */
  runsFiltered: number
  cassettesWritten: number
  /**
   * ExtractionReport counters folded verbatim: emitted-cassette completeness statuses and
   * per-decision selection-skip reasons, keyed by the engine's own names (D-04).
   */
  completeness: Record<string, number>
  cassettesRoot: string
}

/**
 * The extract verb pipeline (D-01/D-02): sweep every handoff under `.agent-qa/runs/` (or the one
 * `--run` names), load each through the version-guarded runner-local loader (typed skips on
 * refusal — pre-366 documents surface here, never as batch errors), and hand every survivor to
 * the sanctioned engines: `extractRunCassettes` selects/projects, `FsCassetteStore` stages
 * idempotently (rm+mkdir recreate). The CLI adds NO selection, completeness, or dedup logic.
 */
export async function runExtractVerb(
  session: EvalSession,
  filters: { run?: string; product?: string } = {},
): Promise<ExtractVerbResult> {
  return await runSafetyScope(
    { executionContext: session.executionContext },
    async () => sweepAndExtract(resolve(session.configDir, '.agent-qa'), filters),
  )
}

// ---- internals --------------------------------------------------------------------------------

function sweepAndExtract(
  agentQaRoot: string,
  filters: { run?: string; product?: string },
): ExtractVerbResult {
  const runsRoot = resolve(agentQaRoot, RUNS_SUBDIR)
  let runSlugs = listRunSlugsWithHandoff(runsRoot)

  if (filters.run !== undefined) {
    const named = filters.run
    runSlugs = runSlugs.filter(slug => slug === named || slug === slugBranch(named))
    if (runSlugs.length === 0) {
      throw new EvalNamedInputError('run', named, runsRoot)
    }
  }

  const store = new FsCassetteStore({ root: agentQaRoot })
  const runsSkipped: { runSlug: string; reason: string }[] = []
  const completeness: Record<string, number> = {}
  let runsFiltered = 0
  let cassettesWritten = 0

  for (const runSlug of runSlugs) {
    let extraction: ReturnType<typeof extractRunCassettes>
    try {
      // The version-guarded loader is the ONE handoff read path (never raw JSON.parse here):
      // unreadable documents and version-guard refusals become typed per-run skips (D-02).
      const handoff = loadCompletedRunHandoff(resolve(runsRoot, runSlug, HANDOFF_FILE))
      if (
        filters.product !== undefined
        && resolveProductPartition(handoff.scope) !== filters.product
      ) {
        runsFiltered++
        continue
      }
      extraction = extractRunCassettes({
        handoff,
        artifacts: new FsRunArtifactSource({ root: agentQaRoot, runId: handoff.runId }),
      })
    } catch (err) {
      runsSkipped.push({ runSlug, reason: err instanceof Error ? err.message : String(err) })
      continue
    }

    for (const extracted of extraction.cassettes) {
      store.write(extracted)
      cassettesWritten++
    }
    for (const emitted of extraction.report.emitted) {
      bumpCounter(completeness, emitted.completenessStatus)
    }
    for (const skip of extraction.report.skips) {
      bumpCounter(completeness, skip.reason)
    }
  }

  return {
    runsSwept: runSlugs.length,
    runsSkipped,
    runsFiltered,
    cassettesWritten,
    completeness,
    cassettesRoot: resolve(agentQaRoot, DEFAULT_EVAL_CASSETTES_SUBDIR),
  }
}

/**
 * Enumerate child run dirs carrying a handoff document (the cache.ts sweep precedent:
 * ENOENT ⇒ empty sweep, never an error). Sorted for a deterministic sweep order.
 */
function listRunSlugsWithHandoff(runsRoot: string): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(runsRoot, { withFileTypes: true })
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return entries
    .filter(entry => entry.isDirectory() && existsSync(resolve(runsRoot, entry.name, HANDOFF_FILE)))
    .map(entry => entry.name)
    .sort()
}

function bumpCounter(counters: Record<string, number>, key: string): void {
  counters[key] = (counters[key] ?? 0) + 1
}

// ---- the cassette source (413-06, D-08) -------------------------------------------------------

/**
 * 413 D-08: which cassette population a batch replays or reports over.
 *
 * `staged` is `.agent-qa/eval/cassettes/` — whatever the last `eval extract` put on this machine.
 * `committed` is `<configDir>/agent-qa-eval/cassettes/` — the REVIEWED corpus: the legacy entries
 * plus every freshly seeded cassette, which is the only population a whole-corpus baseline may be
 * measured over (the legacy cassettes are never re-extracted, so a staged sweep silently omits
 * them and the number would cover a different corpus than Phase 415's floor will).
 *
 * The replay RECORDS root is unaffected by either value: replay output is runtime staging (D-07)
 * and never lands inside the write-once committed root.
 */
export type EvalCorpusSource = 'staged' | 'committed'

/** Resolve the sweep root for a cassette source — the ONE place the two roots are spelled. */
function resolveCassettesRoot(
  session: EvalSession,
  source: EvalCorpusSource,
): { cassettesRoot: string; notice?: string } {
  if (source === 'committed') {
    const cassettesRoot = join(
      resolve(session.configDir, 'agent-qa-eval'),
      COMMITTED_CASSETTES_DIR,
    )
    return { cassettesRoot, notice: `cassette source: committed root ${cassettesRoot}` }
  }
  return {
    cassettesRoot: join(resolve(session.configDir, '.agent-qa'), DEFAULT_EVAL_CASSETTES_SUBDIR),
  }
}

// ---- the replay verb (372-06, D-02/D-06/D-07/D-08) --------------------------------------------

/** D-04 judge honesty counters folded from the PERSISTED score records, never recomputed. */
export interface ReplayJudgeCounters {
  /** Whether a judge resolved from `eval.judge` / `--judge` entered the batch (D-03). */
  configured: boolean
  invoked: number
  settled: number
  abstained: number
  errors: number
  notInvoked: number
}

/** The replay verb's one DTO — the console renders FROM this, never around it (D-04). */
export interface ReplayVerbResult {
  /** sha256hex over the sorted replayed cassette ids ('empty' literal for a zero batch, D-02). */
  batchKey: string
  /** Bundle dirs that entered the sweep (pre-load, pre-filter). */
  swept: number
  /** Cassettes that replayed to a ReplayResult through the sanctioned composition. */
  replayed: number
  /** Typed loadCassetteBundle refusals folded by reason — data, never batch errors (D-08). */
  loadRefusals: Record<string, number>
  /** Typed replay refusals (plus harness errors) folded by reason — the batch never aborts. */
  replayRefusals: Record<string, number>
  /** Persisted score.json records read back after the loop (refusals are never scored). */
  scored: number
  /** Judge dispositions read from the persisted tie/settled stamps (D-04). */
  judge: ReplayJudgeCounters
  /** The staged replay-records root the persisted outcomes landed under. */
  replaysRoot: string
  /** 413 D-08: which cassette population this batch swept — 'staged' unless asked otherwise. */
  source: EvalCorpusSource
  /** Stderr-destined notices: no-judge / family-preflight warnings, harness errors, empty sweep. */
  notices: string[]
  /** Invocation calls include planner, judge and retries; tokens are persisted reported usage. */
  spend: ReplayInvocationSpend
}

export interface ReplayInvocationSpend {
  seed: number | null
  /** Null when no seed was declared or no replay samples were recorded. */
  seedHonored: boolean | null
  decisions: number
  /** Observed provider invocations, including retries and judge calls. Never sample-derived. */
  modelCalls: number
  /** Reported planner + judge usage; failed/unreported attempts may have unknown usage. */
  promptTokens: number
  completionTokens: number
  wallClockMs: number
  sampleCount: number
  samplesMissingTokenUsage: number
  /** Persisted judge outcomes and usage, included in the token totals above. */
  judgeCost: EvalBatchReport['honesty']['judge']['cost']
}

function replayInvocationSpend(
  entries: ScoredBatchEntry[], seed: number | undefined, modelCalls: number, started: number,
  calibration?: EvalBatchReport['calibration'],
): ReplayInvocationSpend {
  const report = buildEvalReport(entries, undefined, undefined, { declaredSeed: seed, calibration })
  const cost = report.totalCost
  const judgeCost = report.honesty.judge.cost
  return {
    seed: seed ?? null,
    seedHonored: cost.sampleCount === 0 ? null : report.seedHonored ?? null,
    decisions: report.headline.perDecisionCost.decisionCount,
    modelCalls,
    promptTokens: cost.promptTokens + judgeCost.inputTokens,
    completionTokens: cost.completionTokens + judgeCost.outputTokens,
    wallClockMs: Math.max(0, Math.round(performance.now() - started)),
    sampleCount: cost.sampleCount,
    samplesMissingTokenUsage: cost.samplesMissingTokenUsage,
    judgeCost,
  }
}

/**
 * The replay verb pipeline (D-01/D-02): sweep every staged cassette bundle (or the ones the
 * filters name), load each through loadCassetteBundle (typed refusals as data), and drive
 * runCassetteReplay — production planner profile, the session's declared mask (441 D-06),
 * D-03 judge bag, replay + score stores. After the loop the
 * judge counters are folded from the PERSISTED ScoreRecords (render from disk, never recompute,
 * D-04). No runSafetyScope wraps the model legs here. `opts` is the TEST-ONLY captured-boundary
 * stub seam (createModel overrides passthrough) — judge/k/seed are NOT verb parameters, they
 * arrive flag-merged on `session.evalConfig` (D-03).
 */
export async function runReplayVerb(
  session: EvalSession,
  filters: { run?: string; cassette?: string; product?: string } = {},
  opts: {
    plannerOverrides?: ModelProviderOverrides
    judgeOverrides?: ModelProviderOverrides
    /** 413 D-08: sweep the committed corpus instead of the staging root. Defaults to 'staged'. */
    source?: EvalCorpusSource
  } = {},
): Promise<ReplayVerbResult> {
  const started = performance.now()
  const agentQaRoot = resolve(session.configDir, '.agent-qa')
  const source: EvalCorpusSource = opts.source ?? 'staged'
  const sourceRoot = resolveCassettesRoot(session, source)
  const cassettesRoot = sourceRoot.cassettesRoot
  // D-07: replay output is runtime staging under .agent-qa/, whichever population was swept —
  // the write-once committed root never receives a replay record.
  const replaysRoot = join(agentQaRoot, DEFAULT_EVAL_REPLAYS_SUBDIR)

  // (1)+(2) sweep + load: every bundle dir enters; refusals fold by reason (D-02/D-08).
  const { swept, loaded, loadRefusals } = loadCassetteBundles(cassettesRoot)

  // (3) filters on the LOADED set — the ONE D-02 vocabulary; a named miss is the only throw.
  const activeCorpus = readActiveCommittedCorpus(resolve(session.configDir, 'agent-qa-eval'), agentQaRoot)
  const activeIds = source !== 'committed' ? undefined : new Set(activeCorpus.snapshot.entries.map(entry => entry.cassetteId))
  let selected = activeIds === undefined ? loaded : loaded.filter(entry => activeIds.has(entry.cassette.id))
  if (filters.cassette !== undefined) {
    const named = filters.cassette
    selected = selected.filter(entry => entry.cassette.id === named)
    if (selected.length === 0) {
      throw new EvalNamedInputError('cassette', named, cassettesRoot, 'replay')
    }
  }
  if (filters.run !== undefined) {
    const named = filters.run
    selected = selected.filter(entry => {
      const head = entry.cassette.id.split('/')[0]
      return head === named || head === slugBranch(named)
    })
    if (selected.length === 0) {
      throw new EvalNamedInputError('run', named, cassettesRoot, 'replay')
    }
  }
  if (filters.product !== undefined) {
    const named = filters.product
    selected = selected.filter(entry => cassetteProductPartition(entry.cassette) === named)
  }
  selected.sort((a, b) => (a.cassette.id < b.cassette.id ? -1 : a.cassette.id > b.cassette.id ? 1 : 0))

  const notices: string[] = []
  if (sourceRoot.notice !== undefined) notices.push(sourceRoot.notice)
  notices.push(...activeCorpus.refusals.map(refusal => `committed read refused ${refusal.path}: ${refusal.reason}`))
  const zeroJudge = (configured: boolean): ReplayJudgeCounters => ({
    configured,
    invoked: 0,
    settled: 0,
    abstained: 0,
    errors: 0,
    notInvoked: 0,
  })

  // (4) empty batch: exit-0 data, no planner/judge resolution spend (D-02).
  if (selected.length === 0) {
    notices.push(`empty sweep — no ${source} cassette bundles matched`)
    return {
      batchKey: 'empty',
      swept,
      replayed: 0,
      loadRefusals,
      replayRefusals: {},
      scored: 0,
      judge: zeroJudge(selectedEvalJudgeNames(session.evalConfig).length > 0),
      replaysRoot,
      source,
      notices,
      spend: replayInvocationSpend([], session.evalConfig.seed, 0, started, activeCorpus?.calibration),
    }
  }

  const batchKey = computeBatchKey(selected.map(entry => entry.cassette.id))

  // (5) planner + judge through the run-parity named-LLM chain (D-03). resolveEvalJudge takes
  // ONE argument: any `--judge` flag was already field-wise merged into session.evalConfig.
  const planner = await resolveReplayPlanner(session)
  const judgeResolution = await resolveEvalJudge(session)
  if (judgeResolution.notice !== undefined) notices.push(judgeResolution.notice)

  // (6) the replay loop, in sorted id order (D-07).
  const recordStore = new FsReplayRecordStore({ root: agentQaRoot })
  const scoreStore = new FsScoreStore({ root: agentQaRoot })
  let modelCalls = 0
  const { replayed, replayRefusals, replayedDirs, notices: replayNotices } =
    await sweepCassetteReplays({
      selected,
      labelRecords: activeCorpus?.snapshot.labelsById,
      profile: planner.profile,
      auth: planner.auth,
      modelCallObservation: { onProviderCall: () => { modelCalls++ } },
      ...(opts.plannerOverrides !== undefined ? { modelOverrides: opts.plannerOverrides } : {}),
      ...(session.evalConfig.k !== undefined ? { k: session.evalConfig.k } : {}),
      ...(session.evalConfig.seed !== undefined ? { seed: session.evalConfig.seed } : {}),
      ...(judgeResolution.judge !== undefined
        ? {
            judge: withJudgeOverrides(judgeResolution.judge, opts.judgeOverrides),
          }
        : {}),
      mask: session.mask,
      recordStore,
      scoreStore,
      replaysRoot,
      // Progress ALWAYS rides stderr — stdout stays reserved for the rendered DTO.
      onProgress: id => process.stderr.write(`replay: ${id}\n`),
    })
  notices.push(...replayNotices)

  // (7) fold judge dispositions FROM the persisted score records — never recomputed (D-04).
  const judge = zeroJudge(judgeResolution.judge !== undefined)
  let scored = 0
  for (const recordDir of replayedDirs) {
    const replay = loadReplayRecord(recordDir)
    const load = loadScoreRecord(recordDir)
    if (replay.kind !== 'loaded') {
      notices.push(`spend replay read refused under ${recordDir}: ${replay.refusal.detail}`)
    }
    if (load.kind === 'absent') continue
    if (load.kind === 'refused') {
      notices.push(`score read refused under ${recordDir}: ${load.refusal.detail}`)
      continue
    }
    scored++
    foldJudgeDispositions(load.record.score, judge)
  }
  const spendBatch = assembleScoredBatch({ replaysRoot, cassettesRoot, source,
    recordDirs: replayedDirs, labelRecords: activeCorpus?.snapshot.labelsById,
    corpusEntriesById: source === 'committed' ? activeCorpus.corpusEntriesById : undefined,
    excludedLabelIds: activeCorpus?.snapshot.excludedLabelIds,
    calibration: activeCorpus?.calibration })
  notices.push(...spendBatch.notices)

  return {
    batchKey,
    swept,
    replayed,
    loadRefusals,
    replayRefusals,
    scored,
    judge,
    replaysRoot,
    source,
    notices,
    spend: replayInvocationSpend(spendBatch.entries, session.evalConfig.seed, modelCalls, started, spendBatch.calibration),
  }
}

/**
 * Fold one persisted CassetteScore's judge stamps into the DTO counters — the exact
 * buildEvalReport disposition read (metrics.ts), scalar-summed for the summary surface (D-04).
 */
function foldJudgeDispositions(score: CassetteScore, judge: ReplayJudgeCounters): void {
  const entries: readonly DecisionScoreEntry[] =
    score.kind === 'leaf' ? [score.entry] : score.kind === 'procedure' ? score.entries : []
  for (const entry of entries) {
    if (entry.kind !== 'decision') continue
    const decision = entry.score
    if (decision.kind === 'unresolved-tie') {
      const outcome = decision.judgeOutcome
      if (outcome === undefined) continue
      if (outcome.kind === 'abstained') {
        judge.abstained++
        judge.invoked++
      } else if (outcome.kind === 'judge-error') {
        judge.errors++
        judge.invoked++
      } else {
        judge.notInvoked++
      }
    } else if (decision.kind === 'scored' && decision.judgeSettled !== undefined) {
      judge.settled++
      judge.invoked++
    }
  }
}

/**
 * Resolve the configured judge (D-03/D-10). An absent `eval.judge` is a typed no-judge notice —
 * unresolved ties will record not-invoked. A resolvable judge flows through the named-LLM chain;
 * a judge whose model family equals the planner's family — or resolves to no family at all —
 * carries a stderr-destined warning notice. The preflight is SOFT: assessJudgeEligibility inside
 * runCassetteReplay stays the per-cassette authority (D-10).
 *
 * eval.judgeAllowSameFamily (owner override of D-10, 2026-07-12): when true, the flag is
 * threaded verbatim onto the judge bundle's allowSameFamily; a KNOWN-same-family pair then
 * yields an override-active ADVISORY instead of the refusal warning. Unknown families keep
 * the refusal-style notice regardless — the opt-in never relaxes unknown ⇒ forbidden.
 */
export async function resolveEvalJudge(session: EvalSession): Promise<{
  judge?: import('@vostride/agent-qa-eval-local').RunCassetteReplayInput['judge']
  notice?: string
}> {
  const names = selectedEvalJudgeNames(session.evalConfig)
  if (names.length === 0) {
    return {
      notice: 'no judge configured — unresolved ties will record not-invoked{no-judge-configured}',
    }
  }

  if (names.length > 1) {
    const members = []
    for (const name of names) members.push(await resolveNamedProfile(name, session.configPath))
    return { judge: { members }, ...(session.evalConfig.judgeAllowSameFamily === true
      ? { notice: 'eval.judgeAllowSameFamily is ignored for a composite judge panel; every member must be disjoint.' }
      : {}) }
  }
  const resolved = await resolveNamedProfile(names[0], session.configPath)
  const planner = await resolveReplayPlanner(session)
  const judgeFamily = resolveJudgeFamily(resolved.profile.model)
  const plannerFamily = resolveJudgeFamily(planner.profile.model)
  const overrideActive = session.evalConfig.judgeAllowSameFamily === true
  const judge = overrideActive ? { ...resolved, allowSameFamily: true } : resolved

  if (judgeFamily !== undefined && plannerFamily !== undefined && judgeFamily === plannerFamily
    && overrideActive) {
    return {
      judge,
      notice:
        `D-10 override active (eval.judgeAllowSameFamily, owner decision 2026-07-12): judge model ` +
        `"${resolved.profile.model}" and planner model "${planner.profile.model}" share the ` +
        `judge family '${judgeFamily}' — same-family judging runs and every scored entry ` +
        'discloses familyOverride: same-family-allowed',
    }
  }

  if (judgeFamily === undefined || plannerFamily === undefined || judgeFamily === plannerFamily) {
    return {
      judge,
      notice:
        `judge model "${resolved.profile.model}" and planner model "${planner.profile.model}" ` +
        'resolve to the same or unknown family — per-cassette judge eligibility will refuse ' +
        'self-judging and ties may record not-invoked',
    }
  }

  return { judge }
}

/**
 * Resolve the replay planner from the config's `use.llm` named entry through the same
 * resolveNamedConfig → resolveModelAuth → toModelProfileAndAuth chain run uses (D-03).
 * An absent `use.llm` is a typed Error (unknown names throw llm-utils' typed
 * available-names error).
 */
export async function resolveReplayPlanner(
  session: EvalSession,
): Promise<{ profile: ModelProfile; auth: ResolvedModelAuth }> {
  const plannerName = session.config.use?.llm
  if (!plannerName) {
    throw new Error(
      'use.llm is not set in the config — the replay planner is the named use.llm registry entry. '
      + 'Set use.llm in agent-qa.config.yaml.',
    )
  }
  return resolveNamedProfile(plannerName, session.configPath)
}

// D-01: three same-seed repeats establish the recorded minimum spread.
export const FLOOR_DEFAULT_REPEATS = 3
// D-01: the recorded pair adds one whole-corpus run under a second seed.
export const FLOOR_DEFAULT_SEEDS = [11, 29] as const
// D-15: fixed resampling seed makes the bootstrap disclosure reproducible.
export const FLOOR_DEFAULT_BOOTSTRAP_SEED = 7

// 420 D-13: twenty joined gold sources per global noisy channel is the recorded floor.
// Wilson intervals disclose finite-sample uncertainty; products never get separate tiny fits.
export const LABEL_CALIBRATION_MIN_GOLD = 20

export type CalibrateVerbResult = Extract<RunLabelCalibrationResult, { artifact: unknown }>
  | { kind: Exclude<RunLabelCalibrationResult['kind'], 'dry-run' | 'committed' | 'unchanged'>; reason: string }

/** The explicit operator panel preview uses credentials only for the declared judge bindings. */
export async function runJudgeCalibrateVerb(session: EvalSession, opts: {
  minN?: number; judgeOverrides?: ModelProviderOverrides; commit?: boolean; replace?: boolean
} = {}): Promise<import('@vostride/agent-qa-eval-local').RunJudgeCalibrationResult & {
  entries?: Awaited<ReturnType<typeof preflightJudgePanel>>['entries']
}> {
  if (opts.replace && !opts.commit) return { kind: 'refused' as const, reason: '--replace requires --commit.' }
  const preflight = await preflightJudgePanel(session, { minN: opts.minN })
  if (preflight.kind === 'capability-gap' && !preflight.identity) return {
    ...await runJudgeCalibration({ kind: 'capability-gap', reason: preflight.reason,
      minN: preflight.minN, commit: opts.commit, replace: opts.replace }), entries: preflight.entries }
  const replayProfile = preflight.kind === 'eligible' ? preflight.replayProfile : await resolveReplayProfileDeclaration(session)
  // Calibration discovers saved floor/gate runs, whose producer always declares seeds.
  const fingerprint = computeReplayProfileFingerprintFor({ profile: replayProfile,
    seedPolicy: 'declared' })
  const context = {
    committedRoot: resolve(session.configDir, 'agent-qa-eval'), agentQaRoot: resolve(session.configDir, '.agent-qa'),
    // Saved evidence must prove this actual planner/profile; judging does not rerun a planner.
    profile: { plannerModelId: replayProfile.model, fingerprint,
      matcherVersion: (await import('@vostride/agent-qa-eval')).projectMatcherConfigContract().version,
      judgeModelId: preflight.identity!.judgeModelId, judgeVersion: preflight.identity!.judgeVersion },
    identity: preflight.identity!, minN: preflight.minN,
  }
  const result = await runJudgeCalibration(preflight.kind === 'eligible'
    ? { kind: 'probe', commit: opts.commit, replace: opts.replace, probe: { ...context, replayProfile,
      members: preflight.members.map(member => ({ ...member, modelOverrides: opts.judgeOverrides })),
      mask: session.mask } }
    : { kind: 'capability-gap', reason: preflight.reason, minN: preflight.minN,
      publication: context, commit: opts.commit, replace: opts.replace })
  return maskJudgeCalibrationText({ ...result, entries: preflight.entries }, session.mask)
}

export type JudgeCalibrateVerbResult = Awaited<ReturnType<typeof runJudgeCalibrateVerb>>

/**
 * 422 D-12 — the ONE rendering of the judge-targeted self-authorship subset.
 *
 * It lives here rather than in `commands/eval.ts` for two reasons: the command layer may not name
 * `@vostride/agent-qa-eval` (FUNC-02 surface firewall), and a staged preview and a stored artifact
 * must print the SAME lines — which is only guaranteed by there being one function to call.
 */
export function renderJudgeTargetedCalibration(
  disclosure?: import('@vostride/agent-qa-eval').JudgeTargetedCalibrationDisclosure,
): string[] {
  // Three states before any number is printed, and none of them may print one: an artifact that
  // predates the field said nothing, and a run that could not read its corpus measured nothing.
  if (disclosure === undefined) {
    return ['judge-targeted adversarial bait: not recorded (this artifact predates the disclosure)']
  }
  if (disclosure.source === 'unavailable') {
    return [`judge-targeted adversarial bait: not determined (${disclosure.reason})`]
  }
  const lines = [
    `judge-targeted adversarial bait: judge-targeted=${disclosure.judgeTargeted}`
      + ` self-authored-by-this-panel=${disclosure.selfAuthored}`
      + ` observed-in-measured-population=${disclosure.observedInCalibration}`,
    `adversarial provenance: model-authored=${disclosure.byProvenance.probe}`
      + ` table-derived=${disclosure.byProvenance.table}`
      + ` legacy-unattributed=${disclosure.byProvenance.absent}`
      + ` malformed=${disclosure.byProvenance.malformed}`
      + ` unresolved=${disclosure.metadataUnavailable}`
      + ` of ${disclosure.total} committed members (arms are counted apart, never summed)`,
  ]
  for (const row of disclosure.byAuthoringModel) {
    lines.push(`author ${row.authoringModel} (${row.authoringFamily})`
      + `${row.panelMember ? ' [panel member — self-authored]' : ''}`
      + `: judge-targeted=${row.judgeTargeted} authored=${row.probeAuthored}`)
  }
  lines.push('Bait counts above are RAW: the agreement, interval, per-member rows and minN are not adjusted for them.')
  return lines
}
export type { JudgeTargetedCalibrationDisclosure } from '@vostride/agent-qa-eval'

// Doctor's independent read-only calibration projection uses this same composition boundary.
export { readJudgeCalibration, computeReplayProfileFingerprintFor }
export { projectMatcherConfigContract } from '@vostride/agent-qa-eval'

/** Only the explicit operator command calls this producer; no model or credential resolution. */
export async function runCalibrateVerb(session: EvalSession, opts: {
  commit?: boolean; replace?: boolean; minGold?: number
} = {}): Promise<CalibrateVerbResult> {
  const minGold = opts.minGold ?? LABEL_CALIBRATION_MIN_GOLD
  if (!Number.isSafeInteger(minGold) || minGold < 2) {
    return { kind: 'refused', reason: '--min-gold must be a safe integer of at least 2.' }
  }
  if (opts.replace && !opts.commit) return { kind: 'refused', reason: '--replace requires --commit.' }
  const result = await runLabelCalibration({
    committedRoot: resolve(session.configDir, 'agent-qa-eval'),
    agentQaRoot: resolve(session.configDir, '.agent-qa'),
    commit: opts.commit, replace: opts.replace,
    minGold: { value: minGold, source: opts.minGold === undefined ? 'default' : 'cli' },
  })
  if ('artifact' in result) return result
  // Never echo input-bearing paths or detector labels in either output format.
  const reasons = {
    refused: 'Calibration inputs unavailable or invalid; inspect committed labels and run evidence.',
    busy: 'Another calibration publisher holds the lock; retry after it finishes.',
    'input-drift': 'Calibration inputs changed; retry from the current snapshot.',
    'publication-failed': 'Calibration publication interrupted; retry the identical command.',
    'write-conflict': 'Calibration bytes conflict; review the dry-run, then use --commit --replace to replace the marker. Immutable revision conflicts require inspection.',
  }
  return { kind: result.kind, reason: reasons[result.kind] }
}

// 417 D-19: 51 demo collateral + one target + four cross-check screens = 56; next power of two.
export const GATE1_DEFAULT_MAX_SCREENS = 64
// 417 D-12: smallest odd k whose ceil(k/2)+1 is a strict supermajority.
export const GATE1_DEFAULT_K = 3

// 2026-09-07, 418 D-13: the >=5-unconfirmed-builds staleness law is the sizing
// precedent: five natural builds with an unexercised anchor form a quiet horizon.
export const GATE2_DEFAULT_CANARY_HORIZON_BUILDS = 5

export function resolveGate2Caps(session: EvalSession) {
  const canaryHorizonBuilds = session.evalConfig.gate2?.canaryHorizonBuilds ?? GATE2_DEFAULT_CANARY_HORIZON_BUILDS
  const maxLowerTrustPerScope = session.evalConfig.gate2?.maxLowerTrustPerScope ?? GATE2_DEFAULT_MAX_LOWER_TRUST_PER_SCOPE
  for (const [name, value] of Object.entries({ canaryHorizonBuilds, maxLowerTrustPerScope })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`eval.gate2.${name} must be a positive integer`)
  }
  return { canaryHorizonBuilds, maxLowerTrustPerScope,
    canaryHorizonBuildsSource: session.evalConfig.gate2?.canaryHorizonBuilds === undefined ? 'default' as const : 'config' as const,
    maxLowerTrustPerScopeSource: session.evalConfig.gate2?.maxLowerTrustPerScope === undefined ? 'default' as const : 'config' as const,
  }
}

export function readCanaryCorpusDigest(session: EvalSession):
  | { kind: 'digest'; corpusDigest: string }
  | { kind: 'no-eval-root' }
  | { kind: 'unavailable'; reason: string } {
  const committedRoot = resolve(session.configDir, 'agent-qa-eval')
  try {
    lstatSync(committedRoot)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'no-eval-root' }
      : { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
  }
  return readCommittedCorpusDigest({ committedRoot })
}

export interface SeedFromFeedbackVerbResult {
  kind: 'admitted' | 'dry-run' | 'nothing-staged' | 'refused'
  reason?: string
  entries: { cassetteId: string; product: string; split: 'natural'; source: 'canary-feedback'; benefit: import('@vostride/agent-qa-schema').Benefit;
    attributedObservationId: string; runId: string; stepIndex: number; captured_at_ordinal: number }[]
  refusals: import('@vostride/agent-qa-eval-local').AdmitStagedFeedbackResult['refusals']
  staleReceipts: ReturnType<typeof LOCAL_CURATION_CAPABILITIES.readStandingGateReceipts> | null
  writesStarted: boolean
  failures: (import('@vostride/agent-qa-eval-local').AdmitStagedFeedbackResult['failures'][number]
    | { phase: 'before-write'; reason: 'feedback-unavailable' | 'no-eval-root' | 'corpus-unavailable' })[]
  previousCorpusDigest?: string
  nextCorpusDigest?: string
  stagingDir: string
  floorCommand: string
}

export async function runSeedFromFeedbackVerb(session: EvalSession, opts: {
  agentQaRoot: string; product?: string; dryRun: boolean; knowledgeRoot?: string
  readStandingGateReceipts?: typeof LOCAL_CURATION_CAPABILITIES.readStandingGateReceipts
}): Promise<SeedFromFeedbackVerbResult> {
  const stagingDir = join(opts.agentQaRoot, FEEDBACK_STAGING_SUBDIR)
  // This is the actual registered floor measurement verb. Measuring does not silently replace
  // a standing write-once floor, and no new model call occurs during feedback admission itself.
  const configArg = `'${resolve(session.configPath).replaceAll("'", "'\"'\"'")}'`
  const floorCommand = `agent-qa --config ${configArg} eval floor`
  const base = { entries: [], refusals: [], staleReceipts: [], writesStarted: false, failures: [], stagingDir, floorCommand }
  const digest = readCanaryCorpusDigest(session)
  if (digest.kind !== 'digest') {
    const reason = digest.kind === 'no-eval-root' ? 'no-eval-root' : 'corpus-unavailable'
    return { ...base, kind: 'refused', reason, failures: [{ phase: 'before-write', reason }] }
  }
  try {
    // Read standing DATA before the operator's write. Gate3 has no digest and is never invented stale.
    const receipts = opts.knowledgeRoot !== undefined && opts.readStandingGateReceipts !== undefined
      ? opts.readStandingGateReceipts({ knowledgeRoot: opts.knowledgeRoot }) : []
    const result = await admitStagedFeedback({ ...opts, committedRoot: resolve(session.configDir, 'agent-qa-eval'),
      mask: committedCorpusMask(session) })
    const selected = opts.dryRun ? result.entries : result.admitted
    const entries = selected.map(entry => ({ cassetteId: entry.extracted.cassette.id, product: entry.product,
      split: 'natural' as const, source: 'canary-feedback' as const, benefit: entry.benefit,
      attributedObservationId: entry.attributedObservationId, runId: entry.runId, stepIndex: entry.stepIndex,
      captured_at_ordinal: entry.extracted.cassette.receipt.buildOrdinal }))
    const moves = opts.dryRun ? entries.length > 0 : result.nextCorpusDigest === undefined ? undefined : result.nextCorpusDigest !== result.previousCorpusDigest
    const refused = result.refusals.length > 0 || result.failures.length > 0
    return { kind: refused ? 'refused' : result.entries.length === 0 ? 'nothing-staged' : opts.dryRun ? 'dry-run' : 'admitted',
      ...(refused ? { reason: 'admission-refused' } : {}), entries, refusals: result.refusals,
      writesStarted: result.writesStarted, failures: result.failures,
      staleReceipts: moves === undefined ? null : moves ? receipts.filter(receipt => receipt.corpusDigest === result.previousCorpusDigest) : [],
      previousCorpusDigest: result.previousCorpusDigest,
      ...(result.nextCorpusDigest === undefined ? {} : { nextCorpusDigest: result.nextCorpusDigest }), stagingDir, floorCommand }
  } catch {
    return { ...base, kind: 'refused', reason: 'feedback-unavailable',
      failures: [{ phase: 'before-write', reason: 'feedback-unavailable' }], previousCorpusDigest: digest.corpusDigest }
  }
}

// ---------------------------------------------------------------------------
// 422 D-01/D-02/D-03: the `eval adversarial` operator verb.
//
// Two branches, one host composition. STAGE is the default and writes only local audit data;
// ADMIT requires an explicit `--batch <digest>` and is the SOLE production caller of
// `refreshAdversarialSplit`. `--dry-run` performs no model call and no write on either branch
// — this whole path makes no model call at all, which is why the session is resolved
// key-only by the command layer.
//
// No guardrail policy is loaded: staged and admitted cases are committed as authored, and a
// refresh settles its tuples by table generation alone (441 D-15).
// ---------------------------------------------------------------------------

export { ADVERSARIAL_STAGING_SUBDIR }
export type { AdversarialRefusal, AdversarialStagingSkip, StagedAdversarialCase }

/**
 * The authoring identity as a DISCLOSURE: provider family, plus a digest standing in for the
 * configured model id. Mirrors `ProbeReservation`'s `authorDigest`/`authorFamily` pair, and for
 * the same stated reason -- a configured model id can itself embed a credential.
 */
export interface AuthoringModelDisclosure {
  /** sha256 of the configured model id -- never the id. */
  idDigest: string
  /** The resolved provider family, which cannot carry a credential. */
  family: string
}

function authoringModelDisclosureOf(model: AuthoringModel): AuthoringModelDisclosure {
  return {
    idDigest: createHash('sha256').update(model.id, 'utf8').digest('hex'),
    family: model.family,
  }
}

export interface AdversarialVerbResult {
  kind: 'staged' | 'unchanged' | 'nothing-derived' | 'dry-run' | 'admitted' | 'partial' | 'refused'
  reason?: string
  retirement?: import('@vostride/agent-qa-eval-local').AdversarialRetirementResult
  lifecycleBusy?: { lockPath: string }
  product: string
  batchDigest?: string
  stagingDir: string
  /** Cases in the reviewed batch (stage branch) — the operator's review list. */
  staged: readonly StagedAdversarialCase[]
  /** Cases whose bytes actually landed in the committed root (admit branch). */
  admitted: readonly StagedAdversarialCase[]
  /** Reviewed cases already committed byte-identically; these move no digest (D-04). */
  unchanged: readonly StagedAdversarialCase[]
  /** Reviewed members that have not landed — nonzero on a partial admission. */
  remaining: readonly StagedAdversarialCase[]
  refusals: readonly AdversarialRefusal[]
  /** Always empty since 441-53 (D-15). */
  settledRefusals: StageAdversarialProposalResult['settledRefusals']
  stagingSkips: readonly AdversarialStagingSkip[]
  skips: StageAdversarialProposalResult['skips']
  seedsConsidered: number
  seedsDeferred: number
  /** NOVEL eligible seeds, counted BEFORE the cap (D-04). */
  eligibleSeeds: number
  /** The resolved per-refresh seed cap and where it came from. */
  cap: AdversarialSeedCap
  tableVersion?: number
  tableHash?: string
  previousCorpusDigest?: string
  nextCorpusDigest?: string
  writesStarted: boolean
  /**
   * The standing Gate-1/Gate-2 receipts this admission staled, derived from the digests that
   * ACTUALLY moved and the receipts ACTUALLY stored — `null` only when the new digest could not
   * be read at all. A Gate-3 receipt carries no corpus digest and is never invented stale.
   */
  staleReceipts: ReturnType<typeof LOCAL_CURATION_CAPABILITIES.readStandingGateReceipts> | null
  /** Admission stales standing receipts; the operator re-measures with this (415 D-12). */
  floorCommand: string
  /**
   * 422 D-09: why this host authored no probes, or ABSENT when the capability was never
   * consulted — the admit branch derives nothing, so it asks nothing.
   */
  noProbeModel?: NoProbeModelGap
  /**
   * The identity that authored this refresh's probes (D-11), REDUCED FOR DISCLOSURE.
   *
   * Family plus a digest, never the configured id. This DTO is what `eval adversarial --json`
   * prints verbatim to stdout, which on any CI host is a log, and it is emitted even on the
   * `nothing-derived` branch where no case was derived. A configured model id can embed a
   * credential; that is why the preflight masks it for its own diagnostics and why
   * `ProbeReservation` records `authorDigest` rather than the id.
   */
  authoringModel?: AuthoringModelDisclosure
  /** The resolved provider-call cap and where it came from (D-04/D-10). */
  probeCap: AdversarialProbeCallCap
  /** What this invocation actually spent at a provider. Zero on every admit branch. */
  spend: AdversarialSpend
  probeSkips: readonly AdversarialProbeSkip[]
  probeRefusals: readonly AdversarialProbeRefusal[]
}

/**
 * What the verb hands the author binding (D-10).
 *
 * `onCallAttempted` is 422-05's pre-invocation seam, and the verb fills it with the one check
 * that must happen at the tightest possible instant: that a durable reservation is already held
 * for the tuple about to be authored. A binding that drops it spends unreserved.
 */
export interface AdversarialProbeAuthorBinding {
  onCallAttempted: (attempt: ProbeCallAttempt) => void
}

export interface AdversarialVerbOptions {
  agentQaRoot: string
  product?: string
  /** Explicit operator admission. Without it the verb stages and commits nothing. */
  admit?: boolean
  /** REQUIRED with `admit`: the exact reviewed batch digest. */
  batch?: string
  dryRun?: boolean
  mutators?: readonly import('@vostride/agent-qa-eval').AdversarialMutator[]
  /** `--max-seeds`; overrides `eval.adversarial.maxSeedsPerRefresh`, which overrides the default. */
  maxSeeds?: number
  /** `--max-probe-calls`; overrides `eval.adversarial.maxProbeCalls`, which overrides the default. */
  maxProbeCalls?: number
  /**
   * Test seam for the resolved probe capability. Production resolves it from the session through
   * the same preflight `doctor` and the chain line read, so all three answer one gap (D-09).
   */
  probeCapability?: AdversarialProbeCapability
  /** Test seam for the author binding. Production binds through `createAdversarialProbeAuthor`. */
  bindProbeAuthor?: (
    author: AdversarialProbeAuthorSelection,
    binding: AdversarialProbeAuthorBinding,
  ) => ProbeAuthorPort
  knowledgeRoot?: string
  readStandingGateReceipts?: typeof LOCAL_CURATION_CAPABILITIES.readStandingGateReceipts
}

export function adversarialHostOptions(session: EvalSession) {
  // The knowledge root and the receipt reader travel with the host so the admission can name
  // what it staled — the same shape `feedbackSeedHostOptions` resolves for the feedback verb.
  return {
    agentQaRoot: resolve(session.configDir, '.agent-qa'),
    knowledgeRoot: resolveKnowledgeRoot(session.config.knowledge, session.configDir),
    readStandingGateReceipts: LOCAL_CURATION_CAPABILITIES.readStandingGateReceipts,
  }
}

/** Operator retirement resolves configuration only; no receipt scan, author or floor work. */
export function runRetireAdversarialVerb(session: EvalSession, opts: { product: string; batch: string }) {
  const result = retireStagedAdversarialBatch({ agentQaRoot: resolve(session.configDir, '.agent-qa'),
    committedRoot: resolve(session.configDir, 'agent-qa-eval'), product: opts.product, batchDigest: opts.batch })
  return { ...result, modelCalls: 0, admitsNothing: true, settledWorkPreserved: true,
    newMeasurementStaleness: false }
}

export async function runAdversarialVerb(
  session: EvalSession,
  opts: AdversarialVerbOptions,
): Promise<AdversarialVerbResult> {
  const committedRoot = resolve(session.configDir, 'agent-qa-eval')
  const product = opts.product ?? 'default'
  const stagingDir = join(opts.agentQaRoot, ADVERSARIAL_STAGING_SUBDIR, slugBranch(product))
  const configArg = `'${resolve(session.configPath).replaceAll("'", "'\"'\"'")}'`
  const floorCommand = `agent-qa --config ${configArg} eval floor`
  // D-04: the cap resolves from the flag, then the host's config, then the recorded default —
  // and says which, because a cap whose origin is invisible is a cap nobody can audit.
  const cap = resolveAdversarialSeedCap(
    opts.maxSeeds !== undefined
      ? { value: opts.maxSeeds, source: 'flag' }
      : session.evalConfig.adversarial?.maxSeedsPerRefresh !== undefined
        ? { value: session.evalConfig.adversarial.maxSeedsPerRefresh, source: 'config' }
        : {},
  )
  // D-10: the SECOND budget, resolved by the same three-step precedence and disclosed the same
  // way. It bounds provider calls, which the seed cap does not and must not — a host that wants
  // many deterministic seeds and no spend has to be able to say so.
  const probeCap = resolveAdversarialProbeCallCap(
    opts.maxProbeCalls !== undefined
      ? { value: opts.maxProbeCalls, source: 'flag' }
      : session.evalConfig.adversarial?.maxProbeCalls !== undefined
        ? { value: session.evalConfig.adversarial.maxProbeCalls, source: 'config' }
        : {},
  )
  const base: AdversarialVerbResult = {
    kind: 'refused', product, stagingDir, staged: [], admitted: [], unchanged: [], remaining: [],
    refusals: [], settledRefusals: [], stagingSkips: [], skips: [], seedsConsidered: 0,
    seedsDeferred: 0, eligibleSeeds: 0, cap, writesStarted: false, staleReceipts: [], floorCommand,
    probeCap, spend: { modelCalls: 0, promptTokens: 0, completionTokens: 0, usageKnown: true },
    probeSkips: [], probeRefusals: [],
  }
  const digest = readCanaryCorpusDigest(session)
  if (digest.kind !== 'digest') {
    const reason = digest.kind === 'no-eval-root' ? 'no-eval-root' : 'corpus-unavailable'
    return { ...base, kind: 'refused', reason }
  }

  if (opts.admit === true) {
    if (opts.batch === undefined) {
      return { ...base, kind: 'refused', reason: 'admit-requires-batch' }
    }
    // Standing DATA is read BEFORE the operator's write, so "what did this admission stale"
    // is answered against the receipts as they stood, not as the write left them.
    let receipts: ReturnType<typeof LOCAL_CURATION_CAPABILITIES.readStandingGateReceipts> = []
    const refreshed = refreshAdversarialSplit({
      agentQaRoot: opts.agentQaRoot,
      committedRoot,
      product,
      batchDigest: opts.batch,
      beforeWrites: () => {
        receipts = opts.knowledgeRoot !== undefined && opts.readStandingGateReceipts !== undefined
          ? opts.readStandingGateReceipts({ knowledgeRoot: opts.knowledgeRoot }) : []
      },
      ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
      mask: committedCorpusMask(session),
    })
    // Derived, never assumed. A refusal that never started writing moved nothing, so it stales
    // nothing — `null` is reserved for the one genuinely unknown case: writes began and the
    // final digest could not be read. An unmoved digest stales nothing either, and a receipt
    // pinned to some other corpus is not swept in. Gate 3 carries no corpus digest at all, so
    // the filter can never reach it (D-12).
    const moves = refreshed.nextCorpusDigest === undefined
      ? refreshed.writesStarted
        ? undefined
        : false
      : refreshed.nextCorpusDigest !== refreshed.previousCorpusDigest
    return {
      ...base,
      kind: refreshed.kind,
      ...(refreshed.reason === undefined ? {} : { reason: refreshed.reason }),
      batchDigest: refreshed.batchDigest,
      admitted: refreshed.admitted,
      unchanged: refreshed.unchanged,
      remaining: refreshed.remaining,
      refusals: refreshed.refusals,
      stagingSkips: refreshed.stagingSkips,
      writesStarted: refreshed.writesStarted,
      ...(refreshed.retirement === undefined ? {} : { retirement: refreshed.retirement }),
      ...(refreshed.lifecycleBusy === undefined ? {} : { lifecycleBusy: refreshed.lifecycleBusy }),
      staleReceipts: moves === undefined
        ? null
        : moves
          ? receipts.filter(receipt => receipt.corpusDigest === refreshed.previousCorpusDigest)
          : [],
      ...(refreshed.previousCorpusDigest === undefined ? {} : { previousCorpusDigest: refreshed.previousCorpusDigest }),
      ...(refreshed.nextCorpusDigest === undefined ? {} : { nextCorpusDigest: refreshed.nextCorpusDigest }),
    }
  }

  // D-09/D-10: who — if anyone — may author probes for this host, and the port that binds them.
  // Resolved BEFORE staging so an unauthorised host learns its gap for free, and so the gap
  // travels on the batch rather than being inferred from an empty probe list.
  const probe = await resolveProbeBinding(session, opts, product)

  const result = await stageAdversarialProposal({
    agentQaRoot: opts.agentQaRoot,
    committedRoot,
    product,
    ...(opts.mutators === undefined ? {} : { mutators: opts.mutators }),
    // Only a NON-default cap is pushed down: the composition owns the recorded default, and
    // handing it back an unattributed value would have it record an operator choice nobody made.
    ...(cap.source === 'default' ? {} : { maxSeeds: cap.value, maxSeedsSource: cap.source }),
    ...(probeCap.source === 'default'
      ? {}
      : { maxProbeCalls: probeCap.value, maxProbeCallsSource: probeCap.source }),
    ...(probe.noProbeModel === undefined ? {} : { noProbeModel: probe.noProbeModel }),
    // A DRY RUN authors nothing. A preview that spends money is not a preview, and there is no
    // way to un-spend it once the batch it previewed is discarded.
    ...(probe.author === undefined || opts.dryRun === true
      ? {}
      : { probeAuthor: probe.author, authoringModel: probe.authoringModel! }),
    ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
  })
  return {
    ...base,
    kind: result.kind,
    ...(result.batchDigest === undefined ? {} : { batchDigest: result.batchDigest }),
    staged: result.staged,
    refusals: result.refusals,
    settledRefusals: result.settledRefusals,
    stagingSkips: result.stagingSkips,
    skips: result.skips,
    seedsConsidered: result.seedsConsidered,
    seedsDeferred: result.seedsDeferred,
    eligibleSeeds: result.eligibleSeeds,
    cap: result.cap,
    tableVersion: result.tableVersion,
    tableHash: result.tableHash,
    previousCorpusDigest: digest.corpusDigest,
    // Staging commits nothing, so nothing it does can stale a standing receipt.
    staleReceipts: [],
    ...(result.noProbeModel === undefined ? {} : { noProbeModel: result.noProbeModel }),
    // The raw id stays on the binding, where derivation and the committed stamp need it. What
    // leaves on the result is the family and a digest -- see AdversarialVerbResult.
    ...(result.authoringModel === undefined
      ? {}
      : { authoringModel: authoringModelDisclosureOf(result.authoringModel) }),
    probeCap: result.probeCap,
    spend: result.spend,
    probeSkips: result.probeSkips,
    probeRefusals: result.probeRefusals,
  }
}

/**
 * Resolve the probe capability and bind its author (D-09/D-10).
 *
 * Imported DYNAMICALLY on purpose: the preflight and the author binding both reach their pure
 * contracts through this module, so a top-level value import would close a runtime cycle. The
 * command layer already imports this module the same way.
 */
async function resolveProbeBinding(
  session: EvalSession,
  opts: AdversarialVerbOptions,
  product: string,
): Promise<{
  author?: ProbeAuthorPort
  authoringModel?: AuthoringModel
  noProbeModel?: NoProbeModelGap
}> {
  const capability = opts.probeCapability
    ?? await (await import('./adversarial-probe-preflight.js')).resolveAdversarialProbeCapability(session)
  if (capability.kind !== 'probe-author') {
    return { noProbeModel: { kind: 'no-probe-model', reason: capability.reason } }
  }
  const bind = opts.bindProbeAuthor ?? await defaultProbeAuthorBinder(session)
  // 422-05's pre-invocation seam, filled with the one check that belongs at the tightest
  // possible instant. The reservation itself is written one layer down, where the durable store
  // and the budget live; this fires immediately before `createModel` and refuses a call that is
  // not already accounted for. A throw here prevents the spend outright, so an unreserved call
  // cannot reach a provider even if some future caller reaches the port by another route.
  const binding: AdversarialProbeAuthorBinding = {
    onCallAttempted: attempt => {
      const state = readProbeAttempt({
        agentQaRoot: opts.agentQaRoot,
        key: {
          product,
          seedCassetteId: attempt.seedCassetteId,
          kind: attempt.kind,
          promptVersion: attempt.promptVersion,
        },
      })
      if (state.kind === 'unattempted') {
        throw new Error('This probe call holds no durable reservation. Nothing reaches a provider before the spend is recorded.')
      }
    },
  }
  return { author: bind(capability.author, binding), authoringModel: capability.author.authoringModel }
}

async function defaultProbeAuthorBinder(
  session: EvalSession,
): Promise<(author: AdversarialProbeAuthorSelection, binding: AdversarialProbeAuthorBinding) => ProbeAuthorPort> {
  const { createAdversarialProbeAuthor } = await import('./adversarial-probe-author.js')
  return (author, binding) => createAdversarialProbeAuthor({
    author,
    executionContext: session.executionContext,
    mask: session.mask,
    onCallAttempted: binding.onCallAttempted,
  })
}

/** Read staged batches back for the operator's review listing; never an admission. */
export function listAdversarialBatches(session: EvalSession, opts: { agentQaRoot: string; product?: string }) {
  void session
  return listStagedAdversarial(opts).map(batch => ({
    dir: batch.dir,
    batchDigest: batch.manifest.batchDigest,
    product: batch.manifest.product,
    tableVersion: batch.manifest.tableVersion,
    tableHash: batch.manifest.tableHash,
    stagedAt: batch.manifest.stagedAt,
    cases: batch.manifest.cases.map(row => ({
      cassetteId: row.cassetteId,
      seedCassetteId: row.seedCassetteId,
      mutator: row.mutator,
      kind: row.kind,
      tableEntryId: row.tableEntryId,
    })),
  }))
}

/** Resolve the existing host roots once for the command; the verb also accepts explicit test DATA. */
export function feedbackSeedHostOptions(session: EvalSession) {
  return { agentQaRoot: resolve(session.configDir, '.agent-qa'),
    knowledgeRoot: resolveKnowledgeRoot(session.config.knowledge, session.configDir),
    readStandingGateReceipts: LOCAL_CURATION_CAPABILITIES.readStandingGateReceipts }
}

// Preserve the existing eval composition boundary; the DATA bridge imports this lazily.
export { runReplayGate, serializeReplayGateReceipt, readLabelCalibration, readCalibrationGoldIdentity } from '@vostride/agent-qa-eval-local'
// The two read-only adversarial state readers, re-exported from the one CLI file the
// surface-firewall ledger clears for `@vostride/agent-qa-eval-local`. Both refuse tampered bytes
// by throwing; neither writes, and neither creates a path.
export { listStagedAdversarial, readAdversarialRefreshRecords } from '@vostride/agent-qa-eval-local'
export type { RunReplayGateInput, RunReplayGateResult } from '@vostride/agent-qa-eval-local'
export type ReplayGateVerbResult = import('./gates/replay-gate-host.js').ReplayGateVerbResult & {
  maxScreens: number
  maxScreensSource: 'flag' | 'config' | 'default'
  k: number
  kSource: 'flag' | 'config' | 'default'
}

export interface ReplayGateVerbOptions {
  resolveTrustPriors?: import('./curation/trust-priors.js').ResolveTrustPriors
  /** Host runtime artifacts and audit root; config and committed roots remain config-relative. */
  agentQaRoot?: string
  /**
   * 422 D-14: writer authority the CALLER already holds, passed straight to the bridge.
   *
   * ADDITIVE-OPTIONAL, so every existing caller — the `eval replay-gate` verb itself, every
   * fixture — keeps the standalone acquire/finally-release posture untouched. Present, the
   * bridge borrows it and takes no lease of its own; see `ReplayGateHostDeps.resolveClaimAuthority`
   * for why the resolution happens at the claim rather than at composition.
   */
  claimAuthority?: import('./gates/replay-gate-host.js').ReplayGateClaimAuthority
  k?: number
  maxScreens?: number
  dryRun?: boolean
  plannerOverrides?: ModelProviderOverrides
  judgeOverrides?: ModelProviderOverrides
  clock?: () => number
  onProgress?: (line: string) => void
}

export async function runReplayGateVerb(
  session: EvalSession,
  candidateId: string,
  opts: ReplayGateVerbOptions = {},
): Promise<ReplayGateVerbResult> {
  const k = opts.k ?? session.evalConfig.k ?? GATE1_DEFAULT_K
  if (!Number.isSafeInteger(k) || k < 3 || k % 2 === 0) {
    throw new TypeError('--k must be an odd integer of at least 3')
  }
  const kSource =
    opts.k !== undefined ? 'flag' : session.evalConfig.k !== undefined ? 'config' : 'default'
  const maxScreens =
    opts.maxScreens ?? session.evalConfig.gate1?.maxScreens ?? GATE1_DEFAULT_MAX_SCREENS
  const maxScreensSource = opts.maxScreens !== undefined ? 'flag'
    : session.evalConfig.gate1?.maxScreens !== undefined ? 'config' : 'default'
  if (!Number.isSafeInteger(maxScreens) || maxScreens < 1) {
    throw new TypeError('--max-screens must be a positive integer')
  }
  const identity = await resolveGateProfileIdentity(session, opts.plannerOverrides)
  const profile = await resolveReplayProfileDeclaration(session)
  // A key-only session deliberately cannot mask. Prepare the full session only when the
  // composition crosses its spend boundary, before resolving provider credentials.
  let execution: Promise<EvalSession> | undefined
  let mask = session.mask
  const names = selectedEvalJudgeNames(session.evalConfig)
  const prepare = () =>
    (execution ??= resolveEvalSession({
      configPath: session.configPath,
      flags: { judge: names },
    }).then(async (full) => {
      if ((await resolveGateProfileIdentity(full, opts.plannerOverrides)).profileKey !== identity.profileKey) {
        throw new EvalJudgeDeclarationError('Gate profile identity changed before execution; re-run eval replay-gate.')
      }
      mask = full.mask
      return full
    }))
  const declarations = await resolveEvalJudgeDeclarations(session)
  const lazyJudges = declarations.map(({ name, profile }) => ({
      profile,
      modelOverrides: opts.judgeOverrides,
      resolveAuth: async () => {
        const full = await prepare()
        return (await resolveNamedProfile(name, full.configPath)).auth
      },
  }))
  const committedRoot = resolve(session.configDir, 'agent-qa-eval')
  const floor = listNoiseFloorArtefacts(committedRoot).artefacts.find(
    (entry) => entry.path === join(committedRoot, committedNoiseFloorPath(identity.profileKey))
      && entry.artefact.profileKey === identity.profileKey,
  )?.artefact
  const { createReplayGateHost } = await import('./gates/replay-gate-host.js')
  const result = await createReplayGateHost({
    ...(opts.resolveTrustPriors === undefined ? {} : { resolveTrustPriors: opts.resolveTrustPriors }),
    // 422 D-14: the lease the caller lent this verb, re-presented to the bridge as a resolver
    // over the value this call already holds. The bridge calls it once, at its own claim.
    ...(opts.claimAuthority === undefined
      ? {}
      : { resolveClaimAuthority: () => opts.claimAuthority }),
    configPath: session.configPath,
    agentQaRoot: opts.agentQaRoot ?? resolve(session.configDir, '.agent-qa'),
    record: opts.dryRun !== true,
    session: {
      ...session,
      mask: (text) => mask(text),
    },
    composition: {
      identity,
      baselineWarmup: { configPath: session.configPath,
        ...(names.length > 1 ? { judges: names } : { judge: names[0] }) },
      k,
      kSource,
      maxScreens,
      planner: {
        profile,
        modelOverrides: opts.plannerOverrides,
        resolveAuth: async () => (await resolveReplayPlanner(await prepare())).auth,
      },
      ...(lazyJudges.length > 1 ? { judgeMembers: lazyJudges } : { judge: lazyJudges[0] }),
      judgeOverrideConfigured: names.length <= 1 && session.evalConfig.judgeAllowSameFamily === true,
      baselineSeed:
        session.evalConfig.seed !== undefined
          ? { seed: session.evalConfig.seed, source: 'config' }
          : { floorSeeds: floor?.seeds ?? [] },
      clock: opts.clock,
      onProgress: opts.onProgress,
    },
  }).run(candidateId)
  const capNotice = `cap: maxScreens=${maxScreens} (${maxScreensSource})`
  return {
    ...result,
    maxScreens,
    maxScreensSource,
    k,
    kSource,
    notices: [...result.notices, ...(names.length > 1 && session.evalConfig.judgeAllowSameFamily === true
      ? ['eval.judgeAllowSameFamily is ignored for a composite judge panel; every member must be disjoint.'] : []), capNotice],
    ...(result.kind === 'receipt' ? { lines: [...result.lines, capNotice] } : {}),
  }
}

/** Measurement data and write-once outcomes, rendered identically on console and JSON. */
export interface FloorVerbResult extends RunNoiseFloorMeasurementResult {
  /** Actual same-seed repeat count supplied to the measurement. */
  repeats: number
  /** Distinct seeds in run order, with the first repeated above. */
  seeds: readonly number[]
  /** Actual deterministic bootstrap seed. */
  bootstrapSeed: number
  /** True only when none of the protocol settings was overridden. */
  recordedDefaults: boolean
  /** Digest of the committed snapshot measured by the composition. */
  corpusDigest: string
  /** Only measured per-run cost lines; raw cassette progress remains stderr-only. */
  costLines: string[]
}

/** Measure the committed corpus through the shared replay/fold/write composition. */
export async function runFloorVerb(
  session: EvalSession,
  opts: {
    repeats?: number
    seeds?: readonly number[]
    bootstrapSeed?: number
    commit?: boolean
    explanation?: string
    classifierRepeatability?: string
    fromMeasured?: string
    plannerOverrides?: ModelProviderOverrides
    judgeOverrides?: ModelProviderOverrides
  } = {},
): Promise<FloorVerbResult> {
  const repeats = opts.repeats ?? FLOOR_DEFAULT_REPEATS
  const seeds = [...new Set(opts.seeds ?? FLOOR_DEFAULT_SEEDS)]
  const bootstrapSeed = opts.bootstrapSeed ?? FLOOR_DEFAULT_BOOTSTRAP_SEED
  // Refuse the protocol before named-profile resolution or credentials can be needed.
  if (!Number.isSafeInteger(repeats) || repeats < FLOOR_PROTOCOL_MINIMUM.repeats
    || seeds.length < FLOOR_PROTOCOL_MINIMUM.seeds || !seeds.every(Number.isSafeInteger)) {
    throw new FloorProtocolError()
  }
  if (!Number.isSafeInteger(bootstrapSeed)) throw new TypeError('--bootstrap-seed must be a safe integer')
  let classifierRepeatability: ClassifierRepeatability | undefined
  if (opts.classifierRepeatability !== undefined) {
    const path = resolve(session.configDir, opts.classifierRepeatability)
    let value: unknown
    try {
      value = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      throw new TypeError(`classifier repeatability unreadable at ${path}: ${(error as Error).message}`)
    }
    const guarded = guardClassifierRepeatability(value)
    if (guarded.kind === 'rejected') {
      throw new TypeError(`classifier repeatability rejected at ${path}: ${guarded.reason}`)
    }
    classifierRepeatability = guarded.repeatability
  }
  // Recovery resolves declarations only; credential and model creation are unreachable.
  const planner = opts.fromMeasured === undefined ? await resolveReplayPlanner(session)
    : { profile: await resolveReplayProfileDeclaration(session) }
  const judgeResolution = opts.fromMeasured === undefined ? await resolveEvalJudge(session) : {}
  const judge = withJudgeOverrides(judgeResolution.judge, opts.judgeOverrides)
  const { plannerModelId, matcherVersion, judgeModelId, judgeVersion } =
    await resolveGateProfileIdentity(session, opts.plannerOverrides)
  if (opts.fromMeasured === undefined && replayJudgeRequest(judge)?.judgeModelId !== judgeModelId) {
    throw new EvalJudgeDeclarationError('Floor judge identity changed before execution; re-run eval floor.')
  }
  const profileKeyInputs = {
    plannerModelId, matcherVersion,
    ...(judgeModelId === undefined ? {} : { judgeModelId, judgeVersion }),
  }
  const costLines: string[] = []
  const result = await runNoiseFloorMeasurement({
    committedRoot: resolve(session.configDir, 'agent-qa-eval'),
    cassettesRoot: resolveCassettesRoot(session, 'committed').cassettesRoot,
    agentQaRoot: resolve(session.configDir, '.agent-qa'),
    ...planner,
    ...(opts.fromMeasured === undefined ? {} : { fromMeasured: resolve(session.configDir, opts.fromMeasured) }),
    modelOverrides: opts.plannerOverrides,
    judge,
    mask: session.mask,
    profileKeyInputs,
    seeds, repeats, bootstrapSeed, classifierRepeatability,
    explanation: opts.explanation,
    commit: opts.commit === true,
    onProgress: line => {
      if (/^floor r\d+ seed=/.test(line)) costLines.push(line)
      process.stderr.write(line + '\n')
    },
  })
  const notices = [...result.notices]
  if (judgeResolution.notice !== undefined) notices.unshift(judgeResolution.notice)
  if (result.committed?.kind === 'refused') notices.push(renderFloorRefusal(result.committed.refusal))
  return {
    ...result, notices, repeats, seeds, bootstrapSeed, costLines,
    recordedDefaults: opts.repeats === undefined && opts.seeds === undefined && opts.bootstrapSeed === undefined,
    corpusDigest: result.artefact.corpusDigest,
  }
}

/** Invocation context added to either the verdict or exact-file refusal arm. */
interface GateVerbContext {
  /** Resolved seed; offline reads disclose selection without making a new call. */
  seed: number
  /** The winning seed declaration, in flag/config/floor/default priority. */
  seedSource: 'flag' | 'config' | 'floor' | 'default'
  /** Absolute directories actually probed, in order; empty for a fresh run. */
  probedDirs: string[]
}

/** Preserve the composition's refusal and actual invocation-observation contracts verbatim. */
export type GateVerbResult = GateVerbContext & (
  | (Extract<RunReleaseGateResult, { kind: 'verdict' }> & {
      /** Absolute actual report path; relative --staged-dir resolves against session.configDir. */
      currentReportFile: string
    })
  | Extract<RunReleaseGateResult, { kind: 'refused' }>
)

/** One fresh replay or a credential-free saved-report comparison through the shared gate. */
export async function runGateVerb(
  session: EvalSession,
  opts: {
    report?: string
    stagedDir?: string
    seed?: number
    plannerOverrides?: ModelProviderOverrides
    judgeOverrides?: ModelProviderOverrides
  } = {},
): Promise<GateVerbResult> {
  if (opts.stagedDir !== undefined && opts.report === undefined) {
    throw new TypeError('--staged-dir requires --report <batchKey>')
  }
  const declaredSeed = opts.seed ?? session.evalConfig.seed
  if (declaredSeed !== undefined && !Number.isSafeInteger(declaredSeed)) {
    throw new TypeError('--seed must be a safe integer')
  }
  const committedRoot = resolve(session.configDir, 'agent-qa-eval')
  const agentQaRoot = resolve(session.configDir, '.agent-qa')
  const { plannerModelId, judgeModelId, judgeVersion, fingerprint, matcherVersion, profileKey } =
    await resolveGateProfileIdentity(session, opts.plannerOverrides)
  const profileKeyInputs = {
    plannerModelId, matcherVersion,
    ...(judgeModelId === undefined ? {} : { judgeModelId, judgeVersion }),
  }
  const floorPath = join(committedRoot, committedNoiseFloorPath(profileKey))
  const floorSeed = declaredSeed === undefined
    ? listNoiseFloorArtefacts(committedRoot).artefacts.find(entry =>
      entry.path === floorPath && entry.profileKey === profileKey)?.artefact.seeds[0] : undefined
  const seed = declaredSeed ?? floorSeed ?? FLOOR_DEFAULT_SEEDS[0]
  const seedSource: GateVerbContext['seedSource'] = opts.seed !== undefined ? 'flag'
    : session.evalConfig.seed !== undefined ? 'config' : floorSeed !== undefined ? 'floor' : 'default'
  const probedDirs: string[] = []
  const notices: string[] = []
  let mode: ReleaseGateMode
  if (opts.report !== undefined) {
    const choices = opts.stagedDir !== undefined
      ? [{ dir: resolve(session.configDir, opts.stagedDir), label: '--staged-dir' }]
      : [
          { dir: join(agentQaRoot, 'eval', 'gate', slugBranch(profileKey), 'reports'), label: 'gate root' },
          { dir: join(agentQaRoot, DEFAULT_EVAL_REPORTS_SUBDIR), label: 'default staging root' },
        ]
    const files: string[] = []
    let stagedOutputDir: string | undefined
    for (const choice of choices) {
      probedDirs.push(choice.dir)
      const file = join(choice.dir, `${slugBranch(opts.report)}.json`)
      files.push(file)
      try {
        lstatSync(file)
      } catch (error) {
        // Only absence permits fallback. Malformed/unreadable data (even a dangling link)
        // selects this root and reaches the composition's exact-file guarded refusal.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      }
      stagedOutputDir = choice.dir
      notices.push(`gate --report: reading ${file} (${choice.label})`)
      break
    }
    if (stagedOutputDir === undefined) {
      return { kind: 'refused', refusal: { path: files[files.length - 1]!,
        reason: `staged report absent; probed ${files.join(', ')}` }, notices,
        seed, seedSource, probedDirs }
    }
    mode = { kind: 'report', batchKey: opts.report, stagedOutputDir,
      profile: await resolveReplayProfileDeclaration(session), modelOverrides: opts.plannerOverrides }
  } else {
    const planner = await resolveReplayPlanner(session)
    const judgeResolution = await resolveEvalJudge(session)
    if (judgeResolution.notice !== undefined) notices.push(judgeResolution.notice)
    mode = {
      kind: 'fresh', ...planner, modelOverrides: opts.plannerOverrides,
      judge: withJudgeOverrides(judgeResolution.judge, opts.judgeOverrides),
      mask: session.mask,
      seed, cassettesRoot: resolveCassettesRoot(session, 'committed').cassettesRoot,
      onProgress: line => process.stderr.write(line + '\n'),
    }
  }
  const result = await runReleaseGate({ committedRoot, agentQaRoot, profileKeyInputs, mode })
  return { ...result, notices: [...notices, ...result.notices], seed, seedSource, probedDirs }
}

// ---- the seed verb (372-07, D-01/D-12/D-16/D-17; 413-06, D-04/D-09) ---------------------------

/**
 * 413 D-04: the three verdict classes that keep a run OUT of the measurement corpus. A run whose
 * failure is not attributable to the product under test — an overlay-interrupted or app-drifted
 * environment, a timeout, a retry-passed flake — measures the harness, not the planner, so it is
 * excluded and COUNTED rather than quietly admitted. Spelled locally on purpose: the same set
 * exists as `NON_ATTRIBUTABLE_FAILURES` in the agent package's canary fold
 * (`packages/agent/src/.../emit-canary-outcomes.ts`), and importing across that boundary would
 * mint an edge the arch contract forbids — the two spellings are the same closed vocabulary.
 */
const EXCLUDED_VERDICT_CLASSES: ReadonlySet<Verdict['class']> = new Set<Verdict['class']>(
  // 414 D-02: the local literal triplet is gone. `EXCLUSION_CLASSES` is the SAME closed
  // vocabulary, and it now also decides what the committed exclusion record admits — a second
  // spelling here could let the seeder drop a run the record schema would refuse to describe.
  EXCLUSION_CLASSES,
)

/** True for exactly the classes the committed exclusion record admits (414 D-02). */
function isExclusionVerdict(
  verdict: SeedRunVerdictRow['verdicts'][number],
): verdict is { class: ExclusionClass; producer: Verdict['producer'] } {
  return EXCLUDED_VERDICT_CLASSES.has(verdict.class)
}

/**
 * 414 D-07: a product's FIRST partition needs both fraction flags, and there is no default
 * anywhere to fall back on — a threshold is chosen after the floor is measured, so guessing one
 * here would silently pick the corpus's held-out set.
 */
export class EvalPartitionFlagsRequiredError extends Error {
  readonly products: readonly string[]

  constructor(products: readonly string[]) {
    super(
      `partition of ${products.join(', ')} requires --held-out-fraction and --private-fraction `
        + 'on its first seed (414 D-07); no default exists',
    )
    this.name = 'EvalPartitionFlagsRequiredError'
    this.products = products
  }
}

/**
 * 414 D-05: the committed manifest disagrees with the supplied fractions. The writer answered
 * `write-conflict` and nothing was touched.
 */
export class EvalPartitionManifestConflictError extends Error {
  readonly product: string
  readonly path: string

  constructor(product: string, path: string) {
    super(
      `partition manifest for ${product} at ${path}: write-conflict — the committed manifest `
        + 'disagrees with the supplied fractions; changing a manifest is a reviewed git edit and '
        + 'a named migration (414 D-05)',
    )
    this.name = 'EvalPartitionManifestConflictError'
    this.product = product
    this.path = path
  }
}

/** One product's partition manifest as the seed DTO echoes it — the DIGEST, never the salt (D-17). */
export interface SeedPartitionRow {
  product: string
  /** Committed-root-relative manifest path. */
  path: string
  outcome: 'written' | 'unchanged'
  /** sha256hex over the committed salt — the raw salt never leaves the manifest file (D-17). */
  saltDigest: string
  heldOutFraction: number
  privateFraction: number
  partitionVersion: number
}

/** One excluded run's committed provenance file, as the seed DTO echoes it (414 D-02). */
export interface SeedExclusionRow {
  runSlug: string
  product: string
  /** Committed-root-relative exclusion path. */
  path: string
  outcome: 'written' | 'unchanged' | 'write-conflict'
}

/** One run's resolved verdicts flattened to the two fields the DTO and the census print (D-04). */
export interface SeedRunVerdictRow {
  /** The run dir name the sweep visited. */
  runSlug: string
  /** The run's resolved product partition — the same key `--product` narrows on. */
  product: string
  /** Every resolved verdict's class and PRODUCER, so a floor answer is never mistaken for one. */
  verdicts: { class: Verdict['class']; producer: Verdict['producer'] }[]
}

/** The seed verb's one DTO — per-handoff SeedingReports aggregated field-wise (D-04). */
export interface SeedVerbResult {
  /** Member-grain exclusions on a mixed run; persisted handoffs retain the source evidence. */
  membersExcluded: { runSlug: string; product: string; testIndex: number;
    verdict: { class: Verdict['class']; producer: Verdict['producer'] } }[]
  admissionConflicts: { runSlug: string; product: string; path: string; reason: 'existing-run-exclusion' }[]
  silverExclusionRows: (SilverExclusion & { runSlug: string; product: string })[]
  supersededOriginalCount: number
  retirementCounts: { missing: number; conflict: number }
  /** Run dirs (with a handoff document) that entered the sweep after `--run` narrowing. */
  runsSwept: number
  /** Per-run typed skips: unreadable / version-refused handoffs (D-02, never batch errors). */
  runsSkipped: { runSlug: string; reason: string }[]
  /** Runs whose product partition differed from `--product`. */
  runsFiltered: number
  /**
   * 413 D-04: runs kept OUT of the corpus because a resolved verdict fell in
   * {@link EXCLUDED_VERDICT_CLASSES}. Each row names the run, its product and EVERY resolved
   * verdict's class + producer — the census prints these, so an exclusion is never a silent drop.
   */
  runsExcluded: SeedRunVerdictRow[]
  /**
   * 413 D-04: runs the filter admitted, carrying the verdicts they were admitted WITH — an empty
   * array is an honest clean run, and a present producer discloses whether the classification
   * came from `analyze-run` or the deterministic floor.
   */
  runsAdmitted: SeedRunVerdictRow[]
  /** Stderr-destined honesty lines: an unreadable analysis.json folded to the floor (T-413-26). */
  notices: string[]
  /** Handoffs whose SeedingPlan executed against the committed root. */
  handoffsSeeded: number
  /** Cases with at least one newly written file, summed across reports. */
  seededCount: number
  /** Cases whose every file was byte-identical (D-17 idempotent no-op), summed. */
  unchangedCount: number
  /** Typed per-case refusals concatenated verbatim — never silent (T-371-18). */
  refusals: SeedingRefusal[]
  /** Matcher skips counted across reports — never silent (T-371-18). */
  pairSkips: number
  /** Sampler exclusions counted across reports — never silent. */
  silverExclusions: number
  /** Both pair classes summed so a starved channel is visible (D-07). */
  pairCounts: { total: number; sameState: number; differingState: number }
  /** D-04 contracts-projection outcomes folded by kind (written/unchanged/write-conflict). */
  contracts: Record<string, number>
  /** D-15 scaffold outcomes (gitignore + root marker) folded by kind. */
  scaffold: Record<string, number>
  /**
   * 414 D-05/D-06/D-07: one row per admitted product's partition manifest — minted on the
   * product's first seed, echoed `unchanged` on every later one. `saltDigest` is the ONLY salt
   * fact that leaves the manifest file (D-17).
   */
  partitions: SeedPartitionRow[]
  /**
   * 414 D-02: one row per excluded run's committed provenance file. An exclusion that leaves no
   * committed trace is an unauditable deletion, so every row the D-04 filter drops writes one.
   */
  exclusionsWritten: SeedExclusionRow[]
  /** ALWAYS `<configDir>/agent-qa-eval` (spec §B7 target-project posture, D-12). */
  committedRoot: string
}

/**
 * The seed verb pipeline (D-01's explicit fourth verb): enumerate handoffs exactly like
 * runExtractVerb (same `--run`/`--product` vocabulary, same typed named-input error, same
 * version-guarded loads with typed skips); per handoff, RE-extract via extractRunCassettes
 * (deterministic — same ids/bytes as the extract verb, D-02; never reconstructed from staged
 * bundles), let buildSeedingPlan decide (eval core is the ONLY decision-maker, D-16), and hand
 * the plan verbatim to seedCommittedCorpus — the CLI adds NO selection or labeling logic.
 * The committed root is ALWAYS `<configDir>/agent-qa-eval`; no flag can retarget it (D-12).
 */
export async function runSeedVerb(
  session: EvalSession,
  filters: { run?: string; product?: string } = {},
  params: {
    silverPerTestCap?: number
    /** 414 D-07: REQUIRED on a product's first partition; no default exists anywhere. */
    heldOutFraction?: number
    /** 414 D-07: REQUIRED on a product's first partition; no default exists anywhere. */
    privateFraction?: number
  } = {},
): Promise<SeedVerbResult> {
  const agentQaRoot = resolve(session.configDir, '.agent-qa')
  const runsRoot = resolve(agentQaRoot, RUNS_SUBDIR)
  let runSlugs = listRunSlugsWithHandoff(runsRoot)

  if (filters.run !== undefined) {
    const named = filters.run
    runSlugs = runSlugs.filter(slug => slug === named || slug === slugBranch(named))
    if (runSlugs.length === 0) {
      throw new EvalNamedInputError('run', named, runsRoot, 'seed')
    }
  }

  const committedRoot = resolve(session.configDir, 'agent-qa-eval')
  // D-03: the explicit param wins over the config/flag-merged eval block, field-wise.
  const silverPerTestCap =
    params.silverPerTestCap ?? session.evalConfig.seeding?.silverPerTestCap

  const result: SeedVerbResult = {
    membersExcluded: [],
    admissionConflicts: [],
    silverExclusionRows: [],
    supersededOriginalCount: 0,
    retirementCounts: { missing: 0, conflict: 0 },
    runsSwept: runSlugs.length,
    runsSkipped: [],
    runsFiltered: 0,
    runsExcluded: [],
    runsAdmitted: [],
    notices: [],
    handoffsSeeded: 0,
    seededCount: 0,
    unchangedCount: 0,
    refusals: [],
    pairSkips: 0,
    silverExclusions: 0,
    pairCounts: { total: 0, sameState: 0, differingState: 0 },
    contracts: {},
    scaffold: {},
    partitions: [],
    exclusionsWritten: [],
    committedRoot,
  }

  // ---- (A) admission: every run's verdicts decided, every exclusion COMMITTED ------------------
  //
  // 414 D-02: an excluded run's provenance is written HERE, before and independently of the
  // partition pre-pass below. A dropped run's committed trace does not wait on a partition
  // decision that has nothing to do with why it was dropped: the writer is write-once (an
  // identical regen answers `unchanged`), and a phase-(B) EvalPartitionFlagsRequiredError leaves
  // the exclusion files in place ON PURPOSE — the operator learns what was excluded from the very
  // invocation that refused to partition. Never reorder (A) after (B).
  const admitted: { runSlug: string; handoff: CompletedRunHandoff; product: string; testIndexes: Set<number> }[] = []
  const initialCommitted = readCommittedCorpus(committedRoot)

  for (const runSlug of runSlugs) {
    try {
      const handoffPath = resolve(runsRoot, runSlug, HANDOFF_FILE)
      const located = relative(realpathSync(agentQaRoot), realpathSync(handoffPath))
      if (located === '..' || located.startsWith('../') || located.startsWith('..\\') || isAbsolute(located)) {
        throw new Error('seed handoff path is outside the operator run root')
      }
      // The version-guarded loader is the ONE handoff read path (D-02 typed per-run skips).
      const handoff = loadCompletedRunHandoff(handoffPath)
      if (slugBranch(handoff.runId) !== runSlug) throw new Error('seed handoff run identity does not match its directory')
      const product = resolveProductPartition(handoff.scope)
      // The product filter runs BEFORE the verdict read so `--product` still narrows the sweep
      // and a partition nobody asked about costs no artifact read.
      if (filters.product !== undefined && product !== filters.product) {
        result.runsFiltered++
        continue
      }
      const verified = loadLabelEvidence({ snapshot: initialCommitted.snapshot, agentQaRoot, incoming: handoff })
      if (!verified.handoffs.some(value => value.runId === handoff.runId)) {
        throw new Error('seed incoming handoff evidence could not be positively verified before admission')
      }
      // 413 D-04: resolve this run's verdicts and decide admission BEFORE anything touches the
      // write-once root — an admitted run cannot be un-seeded without a reviewed deletion, so the
      // filter can only ever run in front of the commit, never after it.
      const analysis = readRunAnalysisArtifact(runsRoot, runSlug, handoff.runId, result.notices)
      const row: SeedRunVerdictRow = {
        runSlug,
        product,
        verdicts: resolveSeedVerdictRows(analysis.artifact, handoff),
      }
      const excluding = row.verdicts.filter(isExclusionVerdict)
      const memberVerdicts = resolveSeedMemberVerdicts(analysis.artifact, handoff)
      const eligible = handoff.tests.filter(member => admitSeedMember(member, memberVerdicts.get(member.testIndex)))
      const hasEligibleRerun = eligible.some(member => member.isRerun)
      if (excluding.length > 0 && !hasEligibleRerun) {
        result.runsExcluded.push(row)
        // The digest names the EVIDENCE the decision was read from: the analysis bytes when an
        // artifact decided it, else the canonical resolved verdict rows the deterministic floor
        // produced. Never a digest of something that did not decide anything.
        const record = projectRunExclusion({
          runId: handoff.runId,
          runSlug,
          product,
          verdicts: excluding,
          analysisDigest:
            analysis.text === undefined
              ? sha256hex(canonicalJson(row.verdicts))
              : sha256hex(analysis.text),
        })
        const outcome = writeRunExclusion({
          record,
          committedRoot,
        })
        // A write-conflict is a DATA row on the DTO, never a throw (D-08).
        result.exclusionsWritten.push({
          runSlug,
          product,
          path: committedExclusionPath(product, runSlug),
          outcome: outcome.kind,
        })
        continue
      }
      const exclusionPath = committedExclusionPath(product, runSlug)
      if (existsSync(join(committedRoot, exclusionPath))) {
        result.admissionConflicts.push({ runSlug, product, path: exclusionPath, reason: 'existing-run-exclusion' })
        result.notices.push(`seed ${runSlug}: existing run exclusion requires the reviewed exclusion path before admission`)
        continue
      }
      const testIndexes = new Set(eligible.map(member => member.testIndex))
      for (const member of handoff.tests) {
        const verdict = memberVerdicts.get(member.testIndex)
        if (!testIndexes.has(member.testIndex) && verdict) {
          result.membersExcluded.push({ runSlug, product, testIndex: member.testIndex, verdict })
        }
      }
      result.runsAdmitted.push(row)
      admitted.push({ runSlug, handoff, product, testIndexes })
    } catch (err) {
      result.runsSkipped.push({
        runSlug,
        reason: err instanceof Error ? err.message : String(err),
      })
      continue
    }
  }

  // ---- (B) the partition pre-pass: one committed manifest per admitted product ----------------
  const manifests = ensurePartitionManifests(session, admitted, committedRoot, result, params)

  // ---- (C) seeding: eval core assigns every split from the committed manifest ------------------
  for (const { runSlug, handoff, product, testIndexes } of admitted) {
    let report: ReturnType<typeof seedCommittedCorpus>
    try {
      const committed = readCommittedCorpus(committedRoot)
      const evidence = loadLabelEvidence({ snapshot: committed.snapshot, agentQaRoot, incoming: handoff })
      for (const refusal of evidence.refusals) result.notices.push(`SOFT evidence ${refusal.runId}: ${refusal.reason}`)
      if (!evidence.handoffs.some(value => value.runId === handoff.runId)) {
        throw new Error('seed incoming handoff evidence could not be positively verified')
      }
      // Only filter AFTER the full incoming bytes have matched the guarded persisted handoff.
      // 441 GAP3-D1: the D-18 text is masked before extraction, so every committed hash is
      // computed over committed text.
      const mask = committedCorpusMask(session)
      const admittedHandoff = maskCorpusText(
        { ...handoff, tests: handoff.tests.filter(member => testIndexes.has(member.testIndex)) }, mask)
      const populationHandoffs = evidence.handoffs.map(source => {
        if (source.runId === handoff.runId) return admittedHandoff
        const sourceAnalysis = readRunAnalysisArtifact(runsRoot, slugBranch(source.runId), source.runId, result.notices)
        const verdicts = resolveSeedMemberVerdicts(sourceAnalysis.artifact, source)
        return maskCorpusText(
          { ...source, tests: source.tests.filter(member => admitSeedMember(member, verdicts.get(member.testIndex))) }, mask)
      })
      const manifest = manifests.get(product)
      if (manifest === undefined) {
        throw new Error(`no committed partition manifest for product ${product}`)
      }
      const extraction = extractRunCassettes({
        handoff: admittedHandoff,
        artifacts: new FsRunArtifactSource({ root: agentQaRoot, runId: handoff.runId }),
      })
      // 414 D-04: the two optional provenance fields are resolved by the CALLER and stamped only
      // when they resolve. `endedAt` is the run's own clock — the cli may read a Date, eval core
      // may not — and the environment is a property of the target registry, never of the handoff.
      const targetEnvironment = resolveTargetEnvironmentForProduct(session.config, product)
      // eval core is the ONLY decision-maker (D-16); the CLI executes the plan verbatim.
      const plan = buildSeedingPlan({
        handoff: admittedHandoff,
        populationContext: { snapshot: committed.snapshot, handoffs: populationHandoffs, marks: evidence.marks },
        cassettes: extraction.cassettes,
        // 414 D-07: the split comes from the product's COMMITTED manifest params — the cli adds
        // no selection or relabel logic of its own.
        partition: partitionParamsOf(manifest),
        capturedAt: new Date(handoff.endedAt).toISOString(),
        ...(targetEnvironment === undefined ? {} : { targetEnvironment }),
        params: {
          ...(silverPerTestCap !== undefined ? { silverPerTestCap } : {}),
        },
        mask,
      })
      report = seedCommittedCorpus({
        plan,
        cassettes: extraction.cassettes,
        committedRoot,
        mask,
      })
      for (const skip of report.softEvidence?.skips ?? []) {
        result.notices.push(`SOFT evidence ${skip.runId}/${skip.testIndex}/${skip.stepIndex}/${skip.attempt}: ${skip.reason}`)
      }
    } catch (err) {
      result.runsSkipped.push({
        runSlug,
        reason: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    result.handoffsSeeded++
    result.seededCount += report.seededCount
    result.unchangedCount += report.unchangedCount
    result.supersededOriginalCount += report.supersededOriginalCount
    result.retirementCounts.missing += report.retirementCounts.missing
    result.retirementCounts.conflict += report.retirementCounts.conflict
    result.silverExclusionRows.push(...report.silverExclusions.map(row => ({ ...row, runSlug, product })))
    result.refusals.push(...report.refusals)
    result.pairSkips += report.pairSkips.length
    result.silverExclusions += report.silverExclusions.length
    result.pairCounts.total += report.pairCounts.total
    result.pairCounts.sameState += report.pairCounts.sameState
    result.pairCounts.differingState += report.pairCounts.differingState
    for (const contract of report.contracts) {
      bumpCounter(result.contracts, contract.outcome)
    }
    bumpCounter(result.scaffold, report.scaffold.gitignore)
    bumpCounter(result.scaffold, report.scaffold.marker)
  }

  return result
}

/**
 * Phase (B) of the seed verb: every admitted product ends this call with exactly one committed
 * partition manifest, and the DTO echoes what happened to each.
 *
 * D-07 ↔ D-05, reconciled. D-07 says a later seed "accepts no fraction flags"; D-05 says a later
 * invocation whose flags DISAGREE with the committed manifest is refused as a write-conflict.
 * Read together: after a product's first partition, a fraction flag can never CHANGE anything.
 * Flags that agree byte-for-byte with the committed manifest are tolerated — they re-derive the
 * IDENTICAL manifest (same committed salt, same fractions), the write-once writer answers
 * `unchanged`, and an operator may therefore keep one invocation in a runbook forever. Flags that
 * disagree are refused. No flag ever writes a second manifest. "Accepts no fraction flags" is
 * enforced as "no fraction flag has any effect after the first partition", which is the only
 * reading consistent with D-05's write-conflict clause.
 *
 * The salt is 32 bytes from `randomBytes` minted HERE, once per product, and committed hex-encoded
 * (D-06). It is never derived from the product slug, a config value or a clock, and no flag can
 * supply one — a predictable salt lets a proposer pre-compute the held-out buckets.
 */
function ensurePartitionManifests(
  session: EvalSession,
  admitted: readonly { product: string }[],
  committedRoot: string,
  result: SeedVerbResult,
  params: { heldOutFraction?: number; privateFraction?: number },
): Map<string, PartitionManifest> {
  const byProduct = new Map<string, PartitionManifest>()
  const read = readPartitionManifests(committedRoot)
  for (const manifest of read.manifests) byProduct.set(manifest.product, manifest)
  // Never silent: a mismatched file name or a refused manifest is a notice, and a product whose
  // manifest was refused reads as unpartitioned below — which the write-once preview then refuses
  // rather than overwriting.
  result.notices.push(...read.notices)
  for (const refusal of read.refusals) {
    result.notices.push(`partition manifest refused at ${refusal.path}: ${refusal.reason}`)
  }

  const products = [...new Set(admitted.map(entry => entry.product))].sort()
  const { heldOutFraction, privateFraction } = params
  const unpartitioned = products.filter(product => !byProduct.has(product))
  if (
    unpartitioned.length > 0
    && (heldOutFraction === undefined || privateFraction === undefined)
  ) {
    throw new EvalPartitionFlagsRequiredError(unpartitioned)
  }

  for (const product of products) {
    const committed = byProduct.get(product)
    const relPath = committedPartitionManifestPath(product)

    if (committed === undefined) {
      // First partition: mint the salt (D-06) and commit the manifest once (D-05).
      const saltHex = randomBytes(32).toString('hex')
      const manifest = projectPartitionManifest({
        product,
        saltHex,
        heldOutFraction: heldOutFraction as number,
        privateFraction: privateFraction as number,
      })
      const outcome = writePartitionManifest({
        manifest,
        committedRoot,
      })
      byProduct.set(product, manifest)
      result.partitions.push(partitionRow(manifest, relPath, requireManifestWritten(outcome, product, relPath)))
      continue
    }

    if (heldOutFraction === undefined || privateFraction === undefined) {
      // A later seed with no fraction flags: echo the committed manifest, write nothing.
      result.partitions.push(partitionRow(committed, relPath, 'unchanged'))
      continue
    }

    // A later seed WITH flags: re-derive from the COMMITTED salt. Agreeing flags round-trip to
    // `unchanged`; disagreeing ones reach the write-once preview and refuse (D-05).
    const reprojected = projectPartitionManifest({
      product,
      saltHex: committed.salt,
      heldOutFraction,
      privateFraction,
    })
    const outcome = writePartitionManifest({
      manifest: reprojected,
      committedRoot,
    })
    result.partitions.push(
      partitionRow(committed, relPath, requireManifestWritten(outcome, product, relPath)),
    )
  }

  return byProduct
}

/** The DTO row for one manifest — `saltDigest`, never the salt (D-17). */
function partitionRow(
  manifest: PartitionManifest,
  path: string,
  outcome: 'written' | 'unchanged',
): SeedPartitionRow {
  return {
    product: manifest.product,
    path,
    outcome,
    saltDigest: sha256hex(manifest.salt),
    heldOutFraction: manifest.heldOutFraction,
    privateFraction: manifest.privateFraction,
    partitionVersion: manifest.partitionVersion,
  }
}

/**
 * 414 D-04: the target environment for one product, or `undefined` when it does not resolve.
 *
 * A `CompletedRunHandoff` carries no target — the environment is a property of the target
 * REGISTRY. Exactly one distinct DECLARED value across the targets whose resolved product equals
 * `product` stamps the field; zero matching targets, an undeclared `environment`, and a mixed set
 * all OMIT it. Never a sentinel, never a guess from the product name, never a majority vote: a
 * fabricated provenance field is worse than an absent one, because only the absent one is honest
 * about what is unknown. `resolveTarget` is the ONE place a target's product is decided (it falls
 * back to the target name), so this reads through it rather than the raw registry record.
 */
export function resolveTargetEnvironmentForProduct(
  config: AgentQaConfig,
  product: string,
): TargetEnvironment | undefined {
  const declared = new Set<TargetEnvironment>()
  for (const summary of listTargets(config)) {
    const target = resolveTarget(config, summary.name)
    if (target.product !== product) continue
    if (target.environment === undefined) continue
    declared.add(target.environment)
  }
  return declared.size === 1 ? [...declared][0] : undefined
}

/**
 * The manifest writer's three outcomes narrowed to the two a partition row can carry. A
 * write-conflict is D-05's refusal and throws.
 */
function requireManifestWritten(
  outcome: ReturnType<typeof writePartitionManifest>,
  product: string,
  path: string,
): 'written' | 'unchanged' {
  if (outcome.kind === 'write-conflict') {
    throw new EvalPartitionManifestConflictError(product, path)
  }
  return outcome.kind
}


/**
 * An admitted analysis artifact AND the exact bytes it was parsed from (414 D-02). Both absent
 * means the deterministic floor decided: no artifact, and therefore no artifact digest.
 */
interface RunAnalysisRead {
  artifact?: RunAnalysisArtifact
  text?: string
}

/**
 * One run's persisted analysis artifact, loaded from its run dir through the ONE schema guard
 * (389 D-09). Absence is the deterministic floor and costs no notice. A PRESENT file recording
 * ANOTHER run's id is refused by identity (`admitAnalysisArtifactForRun`, G-389-3A) so a copied
 * run directory can never flip this run's admission off someone else's verdicts.
 *
 * A file that cannot be read, parsed or guarded is a NOTICE plus the floor — never a per-run skip
 * (T-413-26). Skipping would let a single hand-edited byte remove a run from the corpus silently,
 * which is precisely the tampering the guard exists to surface.
 */
function readRunAnalysisArtifact(
  runsRoot: string,
  runSlug: string,
  runId: string,
  notices: string[],
): RunAnalysisRead {
  const path = join(runsRoot, runSlug, ANALYSIS_FILE)
  if (!existsSync(path)) return {}
  try {
    const text = readFileSync(path, 'utf8')
    const admission = admitAnalysisArtifactForRun(
      guardRunAnalysisArtifact(JSON.parse(text)),
      runId,
    )
    // 414 D-02: the EXACT bytes are carried out beside the parsed artifact, because the committed
    // exclusion record digests the evidence that decided the exclusion — re-serialising the
    // parsed shape would digest this process's formatting, not the file anyone can re-read.
    if (admission.kind === 'admitted') return { artifact: admission.artifact, text }
    notices.push(
      `${ANALYSIS_FILE} for ${runSlug} records run ${admission.recordedRunId}, not `
        + `${admission.resolvingRunId} — deterministic floor used`,
    )
    return {}
  } catch (err) {
    notices.push(
      `${ANALYSIS_FILE} unreadable for ${runSlug}: `
        + `${err instanceof Error ? err.message : String(err)} — deterministic floor used`,
    )
    return {}
  }
}

/**
 * The run's resolved verdict rows, in the exact two-layer order `emit-canary-outcomes.ts` reads
 * them (389 D-10):
 *
 *   1. Members OUTSIDE the accessor's domain first — the runner's one PASS-mintable class is
 *      `flake` (a member that passed only after a retry), and D-04 must see it. `resolveRunVerdicts`
 *      never serves a verdict for a passed member, so reading it here cannot contradict the accessor.
 *   2. THE one supersedable-verdict read — `resolveRunVerdicts`: the artifact's authored verdicts
 *      when one is present, the deterministic floor when it is absent. It OVERWRITES layer 1 for
 *      every member it governs, so an `unknown` → `environment` upgrade excludes the run here
 *      rather than leaving two consumers deriving supersession differently.
 *
 * Sorted by `perTest` so the DTO (and the census that prints it) is order-deterministic.
 */
function resolveSeedVerdictRows(
  artifact: RunAnalysisArtifact | undefined,
  handoff: CompletedRunHandoff,
): SeedRunVerdictRow['verdicts'] {
  return [...resolveSeedMemberVerdicts(artifact, handoff).entries()]
    .sort(([first], [second]) => first - second)
    .map(([, verdict]) => verdict)
}

function resolveSeedMemberVerdicts(
  artifact: RunAnalysisArtifact | undefined,
  handoff: CompletedRunHandoff,
): Map<number, SeedRunVerdictRow['verdicts'][number]> {
  const byPerTest = new Map<number, SeedRunVerdictRow['verdicts'][number]>()
  for (const member of handoff.tests) {
    if (member.rootCause === undefined) continue
    byPerTest.set(member.testIndex, {
      class: member.rootCause.class,
      producer: member.rootCause.producer,
    })
  }
  for (const verdict of resolveRunVerdicts(artifact, handoff)) {
    byPerTest.set(verdict.perTest, { class: verdict.class, producer: verdict.producer })
  }
  return byPerTest
}

// ---- the report verb (372-07, D-13/D-14) -------------------------------------------------------

/** The report verb's one DTO — the console renders FROM this, never around it (D-04). */
export interface ReportVerbResult {
  /** sha256hex over the sorted assembled cassette ids — minted by buildEvalReport (D-13). */
  batchKey: string
  /** Records assembled this invocation, including refusals; zero for committed-history reads. */
  entries: number
  /** The ONE whole-corpus EvalBatchReport — one buildEvalReport call, one headline (D-14). */
  report: EvalBatchReport
  /** The staged file, present only when this invocation assembled and saved a report. */
  stagedFile?: string
  /** Actual report read for --from-committed; no staged file or run receipt is fabricated. */
  committedFile?: string
  /** Decision vectors actually projected for this invocation's report, including an empty set. */
  decisionVectorCount?: number
  /** The typed commitEvalReport outcome when `--commit` ran — write conflicts are DATA (D-08). */
  committed?: CommitEvalReportOutcome
  /** Batch-level judge identity: consistent blocks pass through; mixed/absent surface honestly. */
  judgeIdentity: 'present' | 'absent' | 'mixed'
  /** 413 D-08: which cassette population supplied the label join — 'staged' unless asked. */
  source: EvalCorpusSource
  /**
   * 413 D-19/D-20: the typed baseline-designation outcome when `--baseline` ran. Written,
   * unchanged, REFUSED (a same-family report is not a gate comparator) or a write-conflict —
   * all four are DATA, and the verb's exit code is unaffected by any of them.
   */
  baseline?: WriteBaselinePointerOutcome
  /** 413 D-19: the profile key the designation was composed under, present whenever it ran. */
  profileKey?: string
  /** Stderr-destined notices: read refusals, missing bundles, judge identity honesty. */
  notices: string[]
}

/**
 * The report verb pipeline (D-13/D-14): assemble ONE whole-corpus batch from every persisted
 * replay record under `.agent-qa/eval/replays/` via the 372-02 read legs — entries joined as
 * { cassetteId, outcome, score?, label? } from replay.json / score.json / the staged cassette's
 * label leg. A persisted refusal outcome IS an entry (Pitfall 4 — never dropped). Judge identity
 * threads from the persisted ScoreRecord.judge blocks: consistent blocks pass to buildEvalReport,
 * mixed or absent surfaces honestly — never fabricated (T-372-20). Exactly ONE buildEvalReport
 * call aggregates (the CLI never re-sums scores); the staged report always lands via
 * FsReportStore, and `--commit` additionally routes through commitEvalReport into the
 * committed root (D-13/D-17).
 */
export async function runReportVerb(
  session: EvalSession,
  filters: { run?: string; cassette?: string; product?: string } = {},
  opts: {
    commit?: boolean
    source?: EvalCorpusSource
    baseline?: boolean
    /** Re-designate this exact committed batch without reading replay records or staging. */
    fromCommitted?: string
    /** Required explicit policy for a reviewed --from-committed designation. */
    seedPolicy?: SeedPolicy
    /** No model call: overrides only name the fingerprint shared with a stub-measured floor. */
    plannerOverrides?: ModelProviderOverrides
  } = {},
): Promise<ReportVerbResult> {
  // D-19: a pointer designates a COMMITTED report. Designating a staged-only report would name a
  // batch nobody else can read, so the combination is refused before any work happens (D-08 typed
  // error — the command layer maps it to exit 1).
  if (opts.fromCommitted !== undefined) {
    if (opts.baseline !== true) throw new TypeError('--from-committed requires --baseline')
    if (opts.seedPolicy === undefined) {
      throw new TypeError('--from-committed requires --seed-policy <none|declared>')
    }
    if (opts.commit === true) throw new TypeError('--from-committed cannot be combined with --commit')
    if (!/^[0-9a-f]{64}$/.test(opts.fromCommitted)) {
      throw new TypeError('--from-committed requires a batchKey of 64 lowercase hexadecimal characters')
    }
    if (!SEED_POLICIES.includes(opts.seedPolicy)) {
      throw new TypeError('--seed-policy must be "none" or "declared"')
    }

    const committedRoot = resolve(session.configDir, 'agent-qa-eval')
    const reportList = listCommittedReports(committedRoot)
    const requestedFile = join(committedRoot, 'reports', opts.fromCommitted, 'report.json')
    const entry = reportList.reports.find(candidate => candidate.batchKey === opts.fromCommitted)
    if (entry === undefined) {
      const refusal = reportList.refusals.find(candidate => candidate.path === requestedFile)
      throw new EvalNamedInputError(
        'batchKey', opts.fromCommitted, refusal?.path ?? join(committedRoot, 'reports'),
        'designate', refusal?.reason,
      )
    }
    // The list's key comes from the directory; the light report guard preserves its body.
    // Require all three identities before projecting a pointer to the named history (T-415-42).
    if (entry.path !== requestedFile || entry.report.batchKey !== opts.fromCommitted) {
      throw new EvalNamedInputError(
        'batchKey', opts.fromCommitted, entry.path, 'designate',
        `report batchKey "${entry.report.batchKey}" does not match the requested directory`,
      )
    }
    const notices = reportList.refusals.map(
      refusal => `committed read refused ${refusal.path}: ${refusal.reason}`,
    )
    const designation = await designateReportBaseline(
      session, entry.report, opts.seedPolicy, opts.plannerOverrides, notices,
    )
    return {
      batchKey: entry.report.batchKey,
      entries: 0,
      report: entry.report,
      committedFile: entry.path,
      judgeIdentity: entry.report.judgeIdentity === 'mixed'
        ? 'mixed' : entry.report.judge === undefined ? 'absent' : 'present',
      source: 'committed',
      ...designation,
      notices,
    }
  }
  if (opts.baseline === true && opts.commit !== true) {
    throw new Error(
      '--baseline requires --commit: the pointer designates a COMMITTED report (413 D-19)',
    )
  }
  const agentQaRoot = resolve(session.configDir, '.agent-qa')
  const replaysRoot = join(agentQaRoot, DEFAULT_EVAL_REPLAYS_SUBDIR)
  const source: EvalCorpusSource = opts.source ?? 'staged'
  const sourceRoot = resolveCassettesRoot(session, source)
  const cassettesRoot = sourceRoot.cassettesRoot
  const notices: string[] = []
  if (sourceRoot.notice !== undefined) notices.push(sourceRoot.notice)

  // (1)+(2) Join every persisted replay record to its score, judge identity, and cassette label.
  const labelCorpus = readActiveCommittedCorpus(resolve(session.configDir, 'agent-qa-eval'), agentQaRoot)
  const committedCorpus = source === 'committed' ? labelCorpus : undefined
  notices.push(...labelCorpus.refusals.map(refusal => `committed read refused ${refusal.path}: ${refusal.reason}`))
  const {
    entries: assembled,
    judgeBlocks,
    partitionsById,
    missingBundleCount,
    notices: assemblyNotices,
  } = assembleScoredBatch({ replaysRoot, cassettesRoot, source,
    labelRecords: labelCorpus.snapshot.labelsById,
    excludedLabelIds: labelCorpus.snapshot.excludedLabelIds,
    ...(committedCorpus === undefined ? {} : {
      productByCassetteId: new Map(committedCorpus.snapshot.entries.map(entry => [entry.cassetteId, entry.product])),
      eligibleCassetteIds: new Set(committedCorpus.snapshot.entries.map(entry => entry.cassetteId)),
      corpusEntriesById: committedCorpus.corpusEntriesById,
    }),
  })
  notices.push(...assemblyNotices)
  if (assembled.some(entry => entry.split === undefined)) {
    notices.push('corpus split ownership unknown; entries without corpus metadata are unassigned')
  }
  if (missingBundleCount > 0) {
    notices.push(
      `${missingBundleCount} replay record(s) have no ${source} cassette bundle — label legs absent`,
    )
  }

  // (3) The ONE D-02 filter vocabulary, replay semantics: a named miss is the only throw.
  let entries = assembled
  if (filters.cassette !== undefined) {
    const named = filters.cassette
    entries = entries.filter(entry => entry.cassetteId === named)
    if (entries.length === 0) {
      throw new EvalNamedInputError('cassette', named, replaysRoot, 'report')
    }
  }
  if (filters.run !== undefined) {
    const named = filters.run
    entries = entries.filter(entry => {
      const head = entry.cassetteId.split('/')[0]
      return head === named || head === slugBranch(named)
    })
    if (entries.length === 0) {
      throw new EvalNamedInputError('run', named, replaysRoot, 'report')
    }
  }
  if (filters.product !== undefined) {
    const named = filters.product
    entries = entries.filter(entry => partitionsById.get(entry.cassetteId) === named)
  }
  entries.sort((a, b) => (a.cassetteId < b.cassetteId ? -1 : a.cassetteId > b.cassetteId ? 1 : 0))

  // (4) Batch judge identity from the persisted blocks only (T-372-20): all defined blocks
  // canonicalJson-equal ⇒ the identity passes through; none ⇒ honest absence; differing ⇒
  // 'mixed' and the report carries NO judge block — an identity is never synthesized.
  let judgeIdentity: ReportVerbResult['judgeIdentity']
  let judgeForReport: JudgeIdentityBlock | undefined
  let mixedIdentity: { judgeIdentity: 'mixed'; judgeModelIds: readonly string[] } | undefined
  if (judgeBlocks.length === 0) {
    judgeIdentity = 'absent'
    notices.push('no judge identity on any persisted score record — the report carries no judge block')
  } else {
    const identities = judgeBlocks.map(block => judgeIdentitySchema.strip().parse(block))
    const first = canonicalJson(identities[0])
    if (identities.every(block => canonicalJson(block) === first)) {
      judgeIdentity = 'present'
      judgeForReport = identities[0]
    } else {
      judgeIdentity = 'mixed'
      // 413-15: the report carries the mixture as DATA — the distinct persisted ids, sorted —
      // so `assertBaselineComparator` can refuse it instead of reading it as abstention. Still
      // no synthesized block: a list of the ids actually seen is not an identity (T-372-20).
      mixedIdentity = {
        judgeIdentity: 'mixed',
        judgeModelIds: [...new Set(judgeBlocks.map(block => block.judgeModelId))].sort(),
      }
      notices.push(
        'mixed judge identities across persisted score records — the report carries no judge '
          + 'block (never fabricated)',
      )
    }
  }

  // (5) Exactly ONE buildEvalReport call — one batch, one report, one headline (D-14). The CLI
  // never sums scores; every counter and rate is the aggregator's.
  const report = buildEvalReport(entries, judgeForReport, mixedIdentity, { calibration: labelCorpus.calibration })
  const reportSeedPolicy: SeedPolicy = session.evalConfig.seed !== undefined ? 'declared' : 'none'
  let reportProfileProof: ReturnType<typeof readReportProfileProof>
  if (report.judge?.panelSize !== undefined) {
    // Key-only declarations select evidence; credentials and model binding are never needed.
    let calibrationRead: ReturnType<typeof readJudgeCalibration> | undefined
    try {
      const replayProfile = await resolveReplayProfileDeclaration(session)
      const actualModels = entries.flatMap(entry => {
        if ('kind' in entry.outcome) return []
        const results = entry.outcome.granularity === 'leaf' ? [entry.outcome]
          : entry.outcome.steps.flatMap(step => step.kind === 'decision' ? [step.result] : [])
        return results.map(result => result.replayedModel.modelId)
      })
      if (actualModels.length === 0 || actualModels.some(model => model !== replayProfile.model)) {
        throw new Error('report replay profile unavailable')
      }
      const fingerprint = computeReplayProfileFingerprintFor({ profile: replayProfile,
        seedPolicy: reportSeedPolicy, modelOverrides: opts.plannerOverrides })
      reportProfileProof = readReportProfileProof({ agentQaRoot, replaysRoot, report, entries, fingerprint,
        corpusDigest: computeCorpusDigest(labelCorpus.snapshot.entries), seed: session.evalConfig.seed })
      if (!reportProfileProof) throw new Error('report full profile proof unavailable')
      calibrationRead = readJudgeCalibration({ committedRoot: resolve(session.configDir, 'agent-qa-eval'), agentQaRoot,
        identity: report.judge, profile: { plannerModelId: replayProfile.model, fingerprint,
          matcherVersion: report.matcherVersion, judgeModelId: report.judge.judgeModelId, judgeVersion: report.judge.judgeVersion } })
    } catch { /* Missing profile evidence is unavailable, never a fabricated identity. */ }
    copyJudgeCalibrationToReport(report, calibrationRead)
    if (calibrationRead?.kind !== 'loaded') notices.push('judge calibration unavailable: no matching guarded artifact')
  }
  const vectors = decisionCorrectnessVectors(entries, partitionsById)
  const decisions = projectDecisionVectorsDocument({
    batchKey: report.batchKey, matcherVersion: report.matcherVersion, vectors,
  })

  // (6) The staged report ALWAYS lands (uncommitted runtime staging, batchKey-derived filename).
  if (reportProfileProof) report.runIdentity = reportProfileProof.runIdentity
  const staged = new FsReportStore({ root: agentQaRoot }).save(report, decisions, reportProfileProof?.replayGeneration)

  // (7) `--commit`: render the deterministic markdown projection and route all THREE parts through
  // commitEvalReport into the committed root (D-13) — the typed outcome
  // (committed / write-conflict) folds into the DTO as data (D-08).
  const committedRoot = resolve(session.configDir, 'agent-qa-eval')
  let committed: CommitEvalReportOutcome | undefined
  if (opts.commit === true) {
    committed = commitEvalReport({
      report,
      decisions,
      markdown: renderEvalReportMarkdown(report),
      committedRoot,
    })
  }

  // (8) `--baseline`: designate this committed report as THE comparator for its profile (D-19).
  // The writer refuses first through the ONE comparator predicate (D-20), so a report judged
  // under the same-family override can never become a gate comparator — and the refusal rides
  // the DTO and the notices rather than an exit code, because the report itself is still valid
  // history (D-18). The pointer is per-PROFILE: a number produced by one planner under one
  // matcher and one judge only compares against the same combination.
  let baseline: WriteBaselinePointerOutcome | undefined
  let profileKey: string | undefined
  if (opts.baseline === true) {
    if (committed?.kind !== 'committed') {
      notices.push(
        `baseline pointer skipped: report commit outcome was ${committed?.kind ?? 'absent'}`,
      )
    } else {
      const designation = await designateReportBaseline(
        session, report, reportSeedPolicy, opts.plannerOverrides, notices,
      )
      profileKey = designation.profileKey
      baseline = designation.baseline
    }
  }

  return {
    batchKey: report.batchKey,
    entries: entries.length,
    report,
    stagedFile: staged.file,
    decisionVectorCount: decisions.vectors.length,
    ...(committed !== undefined ? { committed } : {}),
    judgeIdentity,
    source,
    ...(baseline !== undefined ? { baseline } : {}),
    ...(profileKey !== undefined ? { profileKey } : {}),
    notices,
  }
}

/** Both report paths share the same v2 projection and comparator-first write-once writer. */
async function designateReportBaseline(
  session: EvalSession,
  report: EvalBatchReport,
  seedPolicy: SeedPolicy,
  plannerOverrides: ModelProviderOverrides | undefined,
  notices: string[],
): Promise<{ profileKey: string; baseline: WriteBaselinePointerOutcome }> {
  const committedRoot = resolve(session.configDir, 'agent-qa-eval')
  const read = readActiveCommittedCorpus(committedRoot, resolve(session.configDir, '.agent-qa'))
  notices.push(...read.notices)
  for (const refusal of read.refusals) {
    notices.push(`committed read refused ${refusal.path}: ${refusal.reason}`)
  }
  const pointer = projectBaselinePointer({
    plannerModelId: await resolvePlannerModelId(session),
    fingerprint: await resolveReplayProfileFingerprint(session, seedPolicy, plannerOverrides),
    corpusDigest: computeCorpusDigest(read.snapshot.entries),
    matcherVersion: report.matcherVersion,
    ...(report.judge === undefined ? {} : {
      judgeModelId: report.judge.judgeModelId,
      ...(report.judge.judgeVersion === undefined ? {} : { judgeVersion: report.judge.judgeVersion }),
    }),
    batchKey: report.batchKey,
  })
  const baseline = writeBaselinePointer({ report, pointer, committedRoot })
  if (baseline.kind === 'refused') notices.push(renderBaselineComparatorRefusal(baseline.refusal))
  if (seedPolicy === 'none' && (baseline.kind === 'written' || baseline.kind === 'unchanged')) {
    notices.push(
      'baseline designated under seed policy none — eval gate compares against a declared-policy '
      + 'pointer; re-designate with eval report --baseline --from-committed <batchKey> --seed-policy declared',
    )
  }
  return { profileKey: pointer.profileKey, baseline }
}

/**
 * The replay planner's resolved MODEL ID for the D-19 profile key — config only, no credential.
 *
 * `resolveReplayPlanner` resolves auth and throws without a credential, which would make baseline
 * designation impossible on a machine that merely READS a committed report. The profile key needs
 * the declared model id and nothing else, so this reads the named registry entry directly through
 * the same `resolveNamedConfig` leg and stops there. An absent `use.llm` is the same typed error
 * `resolveReplayPlanner` raises — the planner identity is not optional for a comparator.
 */
async function resolvePlannerModelId(session: EvalSession): Promise<string> {
  return (await resolveBaselinePlannerConfig(session)).model
}

/** Shared declaration-only identity; gate overrides remain part of the exact fingerprint. */
export async function resolveGateProfileIdentity(
  session: EvalSession,
  modelOverrides?: ModelProviderOverrides,
): Promise<{
  plannerModelId: string
  judgeModelId?: string
  judgeVersion?: number
  judgeMemberModelIds?: readonly string[]
  fingerprint: string
  matcherVersion: number
  profileKey: string
}> {
  const plannerModelId = await resolvePlannerModelId(session)
  const fingerprint = await resolveReplayProfileFingerprint(session, 'declared', modelOverrides)
  const judgeProfiles = await resolveEvalJudgeDeclarations(session)
  const judgeMemberModelIds = judgeProfiles.map(member => member.profile.model)
  const judgeIdentity = judgeMemberModelIds.length === 0 ? undefined : createPanelIdentity(judgeMemberModelIds)
  const judgeModelId = judgeIdentity?.judgeModelId
  const identity = {
    plannerModelId, fingerprint, matcherVersion: buildEvalReport([]).matcherVersion,
    ...(judgeModelId === undefined ? {} : { judgeModelId, judgeVersion: JUDGE_CONFIG.judgeVersion }),
  }
  return { ...identity, profileKey: composeBaselineProfileKey(identity),
    ...(judgeMemberModelIds.length > 1 ? { judgeMemberModelIds } : {}) }
}

/** Named registry lookup only: neither plugin loading, credentials nor models belong in a key. */
async function resolveEvalJudgeDeclarations(session: EvalSession): Promise<{ name: string; profile: ModelProfile }[]> {
  const { resolveNamedConfig } = await import('./llm-utils.js')
  const members = []
  for (const name of selectedEvalJudgeNames(session.evalConfig)) {
    const { config } = await resolveNamedConfig(name, session.configPath, { keyOnly: true })
    members.push({ name, profile: {
      provider: config.provider, model: config.model, auth: { mode: 'none' as const },
      ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
      ...(config.providerHeaders === undefined ? {} : { headers: config.providerHeaders }),
    } })
  }
  return members
}

/**
 * D-11: config declaration only, with no credential resolution or model creation. The auth
 * declaration mirrors toAuthDeclaration's unresolved/missing case; resolveCapabilities ignores
 * it. Provider transport options are also irrelevant to the resolved replay capabilities.
 */
export async function resolveReplayProfileFingerprint(
  session: EvalSession,
  seedPolicy: SeedPolicy,
  modelOverrides?: ModelProviderOverrides,
): Promise<string> {
  const profile = await resolveReplayProfileDeclaration(session)
  return computeReplayProfileFingerprintFor({ profile, seedPolicy, modelOverrides })
}

/** Shared unresolved declaration for fingerprinting and credential-free offline gate reads. */
export async function resolveReplayProfileDeclaration(
  session: EvalSession,
  namedResolver?: typeof import('./llm-utils.js').resolveNamedConfig,
): Promise<ModelProfile> {
  const config = await resolveBaselinePlannerConfig(session, namedResolver)
  return {
    provider: config.provider,
    model: config.model,
    ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
    ...(config.providerHeaders !== undefined ? { headers: config.providerHeaders } : {}),
    auth: { mode: 'none' },
  }
}

/** The model-id and fingerprint readers share the same named-config validation. */
async function resolveBaselinePlannerConfig(
  session: EvalSession,
  namedResolver?: typeof import('./llm-utils.js').resolveNamedConfig,
) {
  const plannerName = session.config.use?.llm
  if (!plannerName) {
    throw new Error(
      'use.llm is not set in the config — the baseline profile key is keyed on the replay '
      + 'planner, the named use.llm registry entry. Set use.llm in agent-qa.config.yaml.',
    )
  }
  const { resolveNamedConfig } = await import('./llm-utils.js')
  const { config } = await (namedResolver ?? resolveNamedConfig)(plannerName, session.configPath, { keyOnly: true })
  return config
}

// ---- the census verb (413-05, D-13/D-14/D-15/D-16) ---------------------------------------------

/** The census verb's one DTO — the console renders FROM this, never around it (D-04). */
export interface CensusVerbResult {
  /** sha256hex over the canonical cassetteId-sorted committed entry set — names the corpus (D-15). */
  corpusDigest: string
  /** Committed corpus entries the read leg loaded; the census's population. */
  entryCount: number
  /** Product partition dirs seen under `corpus/` — a dir with no admitted entry still shows. */
  productsSeen: readonly string[]
  /** The ONE pure deriveCensus fold — the CLI never re-sums or re-rates anything (D-16). */
  census: CorpusCensus
  /** Absolute path of the guarded `--campaign` manifest when one was supplied. */
  campaignManifest?: string
  /** The typed commitCensus outcome when `--commit` ran — write conflicts are DATA (372 D-08). */
  committed?: CommitCensusOutcome
  /**
   * Read-only floor artefact disclosure, sorted by profileKey (415 D-14). This field never
   * enters deriveCensus or the committed census schema; absent when no guarded floor exists.
   */
  noiseFloor?: {
    profileKey: string
    path: string
    minimumGateSet?: number
    /** The measured artefact's own explanation, including why a value may be absent. */
    minimumGateSetDerivation: string
    classifierRepeatability?: {
      n: number
      k: number
      classFlipRate?: number
      admitExcludeFlipRate?: number
    }
  }[]
  /** Stderr-destined honesty lines: read refusals, cross-check reconciliations, comparator refusals. */
  notices: string[]
}

/**
 * The census verb pipeline (D-13/D-14): the corpus census is a property of the COMMITTED CORPUS,
 * not of a replay batch, so this verb reads the committed root directly through eval-local's read
 * leg and folds it with ONE `deriveCensus` call. Four legs feed that fold:
 *
 *   (a) the corpus itself — entries, label records, cassette bundles and local blob presence;
 *   (b) the optional `--campaign` manifest, whose run-level tallies (excluded runs, repeats, the
 *       model-call and token cost line) the committed root cannot state because an excluded run
 *       leaves no committed entry behind (D-16);
 *   (c) every committed `reports/<batchKey>/report.json`, cross-checked — the two populations are
 *       PRINTED side by side and never reconciled (RESEARCH F7: a report carries a batchKey, never
 *       its cassette-id list), and each report is run through the ONE comparator predicate so a
 *       same-family report can never be mistaken for a gate comparator (D-18/D-20, ROOT-11).
 *   (d) 414 D-17: the committed `contracts/partition-<product>.json` manifests and the
 *       `exclusions/<product>/<runSlug>.json` records, plus the read leg's `schemaVersionsSeen`.
 *       The manifest travels into the census as `sha256hex(salt)` only — the fold does the
 *       digesting, so the raw salt never reaches a DTO the console or a committed file can print.
 *
 * Refusal posture: an unreadable committed file is a NOTICE, never a throw — the verb completes
 * and prints what it could not read (T-413-24). The single typed error is a rejected `--campaign`
 * manifest (T-413-21): the command layer maps it to exit 1. No console output lives here (D-04).
 */
export async function runCensusVerb(
  session: EvalSession,
  opts: { commit?: boolean; campaign?: string } = {},
): Promise<CensusVerbResult> {
  const committedRoot = resolve(session.configDir, 'agent-qa-eval')
  const notices: string[] = []

  // (1) The committed root read leg — refusals are data, an absent root is an empty census.
  //
  // 414 D-02/D-05: the two committed document kinds this phase introduced are read HERE, in the
  // one file the surface-firewall ledger clears for `@vostride/agent-qa-eval-local`, and handed to
  // `deriveCensus` as DATA. Every refusal from either read becomes a notice: a manifest or an
  // exclusion the guard rejects must be NAMED, because silently dropped it reads as "this product
  // is unpartitioned" or "this run was never excluded" — a false count, not a missing one
  // (T-414-41).
  const read = readActiveCommittedCorpus(committedRoot, resolve(session.configDir, '.agent-qa'))
  const manifestRead = readPartitionManifests(committedRoot)
  const exclusionRead = readRunExclusions(committedRoot)
  notices.push(...read.notices, ...manifestRead.notices)
  for (const refusal of [...read.refusals, ...manifestRead.refusals, ...exclusionRead.refusals]) {
    notices.push(`committed read refused ${refusal.path}: ${refusal.reason}`)
  }

  // (2) The optional campaign manifest. `guardCampaignManifest` is STRICT and its TypeError
  // propagates deliberately — a widened or misspelt manifest is a typed input error, never a
  // silently dropped tally (T-413-21). Its digest is stamped into the committed census bytes.
  let campaign: DeriveCensusInput['campaign']
  let campaignManifest: string | undefined
  if (opts.campaign !== undefined) {
    campaignManifest = resolve(process.cwd(), opts.campaign)
    const manifest = guardCampaignManifest(JSON.parse(readFileSync(campaignManifest, 'utf8')))
    campaign = { legs: manifest.legs, manifestDigest: sha256hex(canonicalJson(manifest)) }
  }

  // (3) Cross-check EVERY committed report: the reconciliation line, the comparator verdict from
  // the ONE predicate, and the D-19 pointer designations that name it.
  const reportList = listCommittedReports(committedRoot)
  const pointerList = listBaselinePointers(committedRoot)
  for (const refusal of [...reportList.refusals, ...pointerList.refusals]) {
    notices.push(`committed read refused ${refusal.path}: ${refusal.reason}`)
  }

  const reports: NonNullable<DeriveCensusInput['reports']>[number][] = []
  for (const entry of reportList.reports) {
    const comparator = assertBaselineComparator(entry.report)
    const designatedBy = pointerList.pointers
      .filter(pointer => pointer.batchKey === entry.batchKey)
      .map(pointer => pointer.profileKey)
      .sort()
    notices.push(
      `cross-check ${entry.batchKey}: report decisions `
        + `${entry.report.headline.perDecisionCost.decisionCount} vs corpus cassettes `
        + `${read.snapshot.entries.length} — batch membership differs (batchKey only)`,
    )
    if (!comparator.ok) notices.push(renderBaselineComparatorRefusal(comparator.refusal))
    reports.push({ report: entry.report, comparator, designatedBy })
  }

  // D-14: disclose each guarded floor beside the census, without changing the census input.
  const floorList = listNoiseFloorArtefacts(committedRoot)
  for (const refusal of floorList.refusals) {
    notices.push(`committed read refused ${refusal.path}: ${refusal.reason}`)
  }
  const noiseFloor = floorList.artefacts.map(({ profileKey, path, artefact }) => {
    const repeatability = artefact.classifierRepeatability
    return {
      profileKey,
      path,
      ...(artefact.minimumGateSet.value === undefined
        ? {} : { minimumGateSet: artefact.minimumGateSet.value }),
      minimumGateSetDerivation: artefact.minimumGateSet.derivation,
      ...(repeatability === undefined ? {} : {
        classifierRepeatability: {
          n: repeatability.n,
          k: repeatability.k,
          ...(repeatability.classFlipRate === undefined
            ? {} : { classFlipRate: repeatability.classFlipRate }),
          ...(repeatability.admitExcludeFlipRate === undefined
            ? {} : { admitExcludeFlipRate: repeatability.admitExcludeFlipRate }),
        },
      }),
    }
  })

  // (4) The ONE pure fold — every counter, rate and tally in the DTO is the derivation's.
  const census = deriveCensus({
    snapshot: read.snapshot,
    ...(read.corpusEntriesById === undefined ? {} : { corpusEntriesById: read.corpusEntriesById }),
    ...(read.retiredMarkedCassetteIds === undefined ? {} : { retiredMarkedCassetteIds: read.retiredMarkedCassetteIds }),
    ...(campaign === undefined ? {} : { campaign }),
    reports,
    manifests: manifestRead.manifests,
    exclusions: exclusionRead.exclusions,
    schemaVersionsSeen: read.schemaVersionsSeen,
  })

  // (5) `--commit`: render the deterministic markdown projection and route BOTH parts through
  // commitCensus into `reports/census/<corpus-digest>/` (D-15). The typed
  // outcome (committed / write-conflict) folds into the DTO as data (372 D-08).
  let committed: CommitCensusOutcome | undefined
  if (opts.commit === true) {
    committed = commitCensus({
      census,
      markdown: renderCensusMarkdown(census),
      committedRoot,
    })
  }

  return {
    corpusDigest: census.corpusDigest,
    entryCount: census.entryCount,
    productsSeen: read.productsSeen,
    census,
    ...(campaignManifest !== undefined ? { campaignManifest } : {}),
    ...(committed !== undefined ? { committed } : {}),
    ...(noiseFloor.length === 0 ? {} : { noiseFloor }),
    notices,
  }
}

// ---- internals --------------------------------------------------------------------------------

/**
 * The named-LLM resolution chain shared by judge and planner: resolveNamedConfig (typed
 * available-names error on unknown name) → resolveModelAuth → toModelProfileAndAuth. A `missing`
 * auth resolution is a typed Error naming `agent-qa auth login` (D-08). Lazy dynamic import per
 * the auth.ts house style.
 */
async function resolveNamedProfile(
  name: string,
  configPath: string,
): Promise<{ profile: ModelProfile; auth: ResolvedModelAuth }> {
  const { resolveNamedConfig, resolveModelAuth, toModelProfileAndAuth } = await import('./llm-utils.js')
  const { config } = await resolveNamedConfig(name, configPath)
  const auth = await resolveModelAuth(config.name, config)
  if (auth.kind === 'missing') {
    throw new Error(
      `No credentials for LLM config "${config.name}": ${auth.message} `
      + 'Run `agent-qa auth login` to authenticate.',
    )
  }
  return toModelProfileAndAuth(config, auth)
}

/**
 * Load the workspace secrets file into a SecretStore (the run.ts loadRuntimeSecrets recipe,
 * reimplemented with typed errors — D-05 forbids touching the run module and D-08 forbids
 * process.exit here). Missing/unreadable/invalid all throw typed Errors naming the path.
 */
async function loadEvalSecretStore(
  config: AgentQaConfig,
  configDir: string,
): Promise<SecretStore> {
  const secretsPath = resolve(configDir, config.workspace.secretsFile)

  let content: string
  try {
    content = await readFile(secretsPath, 'utf-8')
  } catch {
    throw new Error(
      `Secrets file not found or unreadable: ${secretsPath}. `
      + 'Create the file before running eval verbs (it may be empty, but it must exist).',
    )
  }

  try {
    const { SecretStore } = await import('@vostride/agent-qa-runner')
    return SecretStore.fromEnvContent(content)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Secrets file is invalid: ${secretsPath}: ${message}`)
  }
}

/** Field-wise merge of flag overrides over the config eval block — flags win (D-03). */
function mergeEvalConfig(
  fromConfig: AgentQaConfig['eval'],
  flags?: EvalSessionFlags,
): EvalCliConfig {
  const configured = selectedEvalJudgeNames(fromConfig ?? {})
  const names = flags?.judge === undefined ? configured
    : selectedEvalJudgeNames(typeof flags.judge === 'string' ? { judge: flags.judge } : { judges: flags.judge })
  const judgeAllowSameFamily = fromConfig?.judgeAllowSameFamily
  const k = flags?.k ?? fromConfig?.k
  const seed = flags?.seed ?? fromConfig?.seed
  const silverPerTestCap = flags?.silverCap ?? fromConfig?.seeding?.silverPerTestCap

  return {
    ...(names.length === 1 ? { judge: names[0] } : names.length > 1 ? { judges: names } : {}),
    ...(judgeAllowSameFamily !== undefined ? { judgeAllowSameFamily } : {}),
    ...(k !== undefined ? { k } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(fromConfig?.gate2 === undefined ? {} : { gate2: fromConfig.gate2 }),
    ...(fromConfig?.adversarial === undefined ? {} : { adversarial: fromConfig.adversarial }),
    ...(silverPerTestCap !== undefined ? { seeding: { silverPerTestCap } } : {}),
    // 422-09: forwarded WHOLE, exactly as `gate2` and `adversarial` above are. The field-by-field
    // rebuild this replaces silently dropped every member the schema gained after it was written.
    ...(fromConfig?.gate1 === undefined ? {} : { gate1: fromConfig.gate1 }),
  }
}
// Gate hosts reach eval/runtime storage only through this established composition boundary.
export { FsHandoffSource, FsMarkLedger, MARK_INTENT_FILE, MarkLedgerCorruptError, latestMarkReceiptFor } from '@vostride/agent-qa-eval-local'
export { HANDOFF_FILE, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
export { runSafetyScope } from '@vostride/agent-qa-safety-local'
export { createModel } from '@vostride/agent-qa-model'
export type { AgentQaConfig as FeedbackWordingConfig } from '@vostride/agent-qa-core'
// 2026-09-11, 422 D-09/D-10: the adversarial probe preflight and the author binding reach the
// pure probe contracts through this same composition boundary the judge preflight uses. The
// FUNC-02 surface firewall ledgers this file for `@vostride/agent-qa-eval` and only ever
// shrinks, so a new CLI file may never name that package itself.
export { NO_PROBE_MODEL_REASONS, renderAdversarialProbePrompt } from '@vostride/agent-qa-eval'
export type {
  AuthoringModel, GenerationRequest, NoProbeModelGap, NoProbeModelReason,
  ProbeAuthorPort, ProbeGeneratorKind, ProbeText, ProbeUsage,
} from '@vostride/agent-qa-eval'
export { resolveAdversarialProbeCapability } from './adversarial-probe-preflight.js'
export type {
  AdversarialProbeAuthorSelection, AdversarialProbeCapability, AdversarialProbePreflightDeps,
} from './adversarial-probe-preflight.js'
export { createAdversarialProbeAuthor } from './adversarial-probe-author.js'
export type {
  AdversarialProbeAuthorInput, ProbeCallAttempt,
} from './adversarial-probe-author.js'
