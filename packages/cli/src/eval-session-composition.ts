// The CLI composition root for the eval verbs. It resolves the one eval session (the merged eval
// config, a SecretRedactor over the workspace secrets file as the mask, and the named planner and
// judge profiles through the same resolveNamedConfig → resolveModelAuth chain run uses) and runs
// extract, replay and report. Errors are typed; the command layer maps them to exit codes. As a
// surface it uses node builtins directly.

import { existsSync, readdirSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  HANDOFF_FILE,
  RUNS_SUBDIR,
  loadCompletedRunHandoff,
  slugBranch,
} from '@vostride/agent-qa-runner-local'
import {
  assertBaselineComparator,
  buildEvalReport,
  canonicalJson,
  computeBatchKey,
  computeCorpusDigest,
  decisionCorrectnessVectors,
  extractRunCassettes,
  JUDGE_CONFIG,
  judgeIdentitySchema,
  projectBaselinePointer,
  projectDecisionVectorsDocument,
  renderBaselineComparatorRefusal,
  resolveJudgeFamily,
  resolveProductPartition,
  SEED_POLICIES,
} from '@vostride/agent-qa-eval'
import type {
  BaselineComparatorRefusal,
  CassetteScore,
  DecisionScoreEntry,
  EvalBatchReport,
  JudgeIdentityBlock,
  SeedPolicy,
  ScoredBatchEntry,
} from '@vostride/agent-qa-eval'
import {
  COMMITTED_CASSETTES_DIR,
  DEFAULT_EVAL_CASSETTES_SUBDIR,
  DEFAULT_EVAL_REPLAYS_SUBDIR,
  FsCassetteStore,
  FsReplayRecordStore,
  FsReportStore,
  readReportProfileProof,
  FsRunArtifactSource,
  FsScoreStore,
  assembleScoredBatch,
  copyJudgeCalibrationToReport,
  readJudgeCalibration,
  cassetteProductPartition,
  commitEvalReport,
  computeReplayProfileFingerprintFor,
  listCommittedReports,
  loadCassetteBundles,
  loadReplayRecord,
  loadScoreRecord,
  readActiveCommittedCorpus,
  sweepCassetteReplays,
  writeBaselinePointer,
} from '@vostride/agent-qa-eval-local'
import type {
  CommitEvalReportOutcome,
  WriteBaselinePointerOutcome,
} from '@vostride/agent-qa-eval-local'
import { runSafetyScope } from '@vostride/agent-qa-safety-local'
import type {
  ModelProfile,
  ModelProviderOverrides,
  ResolvedModelAuth,
} from '@vostride/agent-qa-model'
import { sha256hex } from '@vostride/agent-qa-schema'
import type { MaskFn } from '@vostride/agent-qa-schema'
import type { SecretStore } from '@vostride/agent-qa-runner'
import type { AgentQaConfig } from '@vostride/agent-qa-core'
import { loadConfigFile, resolveConfig } from './config.js'
import { renderEvalReportMarkdown } from './eval-report-render.js'
import { resolveRunExecutionContext } from '@vostride/agent-qa-agent-local'
import type { RunExecutionContext } from '@vostride/agent-qa-agent-local'

// The @vostride/agent-qa-eval-local workspace edge (G5) is anchored by the real store/loader
// value imports above (372-05/06); this type re-export stays for the report verb plan (372-07)
// that consumes record loads. Erased at build — no runtime coupling.
export type { ReplayRecordLoad } from '@vostride/agent-qa-eval-local'

export type { BaselineComparatorRefusal } from '@vostride/agent-qa-eval'

// 413-06 D-20: the ONE refusal renderer, re-exported so `commands/eval.ts` can print a refused
// baseline designation WITHOUT minting a second surface-firewall edge of its own — the command
// layer receives it through this ledgered root exactly as it receives the verb pipelines.
export { renderBaselineComparatorRefusal, SEED_POLICIES } from '@vostride/agent-qa-eval'
export type { SeedPolicy } from '@vostride/agent-qa-eval'
export type { WriteBaselinePointerOutcome } from '@vostride/agent-qa-eval-local'

/** The user-facing eval params (config `eval:` block merged with per-invocation flags, D-03). */
export interface EvalCliConfig {
  judge?: string
  judges?: readonly string[]
  /** Owner override of D-10 (2026-07-12): explicit default-off same-family judging opt-in. */
  judgeAllowSameFamily?: boolean
  k?: number
  seed?: number
}

/** The one resolved session every eval verb consumes (D-05). */
export interface EvalSessionFlags {
  judge?: string | readonly string[]
  k?: number
  seed?: number
}

export class EvalJudgeDeclarationError extends TypeError {
  constructor(message: string) { super(message); this.name = 'EvalJudgeDeclarationError' }
}

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

// Trust-prior resolution reads label calibration through this composition boundary.
export { readLabelCalibration, readCalibrationGoldIdentity } from '@vostride/agent-qa-eval-local'

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

  return {
    ...(names.length === 1 ? { judge: names[0] } : names.length > 1 ? { judges: names } : {}),
    ...(judgeAllowSameFamily !== undefined ? { judgeAllowSameFamily } : {}),
    ...(k !== undefined ? { k } : {}),
    ...(seed !== undefined ? { seed } : {}),
  }
}
// Gate hosts reach eval/runtime storage only through this established composition boundary.
export { FsHandoffSource, FsMarkLedger, MARK_INTENT_FILE, MarkLedgerCorruptError, latestMarkReceiptFor } from '@vostride/agent-qa-eval-local'
export { HANDOFF_FILE, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
export { runSafetyScope } from '@vostride/agent-qa-safety-local'
export { createModel } from '@vostride/agent-qa-model'
export type { AgentQaConfig as FeedbackWordingConfig } from '@vostride/agent-qa-core'
