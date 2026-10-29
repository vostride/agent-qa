// The CLI composition root for the eval verbs. It resolves the one eval session (replay's flag
// settings, a SecretRedactor over the workspace secrets file as the mask, and the named planner and
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
  buildEvalReport,
  canonicalJson,
  computeBatchKey,
  extractRunCassettes,
  JUDGE_CONFIG,
  judgeIdentitySchema,
  resolveJudgeFamily,
  resolveProductPartition,
} from '@vostride/agent-qa-eval'
import type {
  CassetteScore,
  DecisionScoreEntry,
  EvalBatchReport,
  JudgeIdentityBlock,
  ScoredBatchEntry,
} from '@vostride/agent-qa-eval'
import {
  DEFAULT_EVAL_CASSETTES_SUBDIR,
  DEFAULT_EVAL_REPLAYS_SUBDIR,
  FsCassetteStore,
  FsReplayRecordStore,
  FsReportStore,
  FsRunArtifactSource,
  FsScoreStore,
  assembleScoredBatch,
  cassetteProductPartition,
  loadCassetteBundles,
  loadReplayRecord,
  loadScoreRecord,
  sweepCassetteReplays,
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
import { resolveConfig } from './config.js'
import { resolveRunExecutionContext } from '@vostride/agent-qa-agent-local'
import type { RunExecutionContext } from '@vostride/agent-qa-agent-local'

// Type-only and erased at build; the value imports above anchor the eval-local edge.
export type { ReplayRecordLoad } from '@vostride/agent-qa-eval-local'

/** Replay's settings, taken from the flags of `agent-qa eval replay`. */
export interface EvalCliConfig {
  judge?: string
  judges?: readonly string[]
  judgeAllowSameFamily?: boolean
  k?: number
  seed?: number
}

export interface EvalSessionFlags {
  judge?: string | readonly string[]
  judgeAllowSameFamily?: boolean
  k?: number
  seed?: number
}

export class EvalJudgeDeclarationError extends TypeError {
  constructor(message: string) { super(message); this.name = 'EvalJudgeDeclarationError' }
}

/** Validate the `--judge` names; repeated names keep their multiplicity and order. */
export function selectedEvalJudgeNames(judge: string | readonly string[] | undefined): readonly string[] {
  const names = judge === undefined ? [] : typeof judge === 'string' ? [judge] : judge
  if (!Array.isArray(names) || Array.from(names).some(name => typeof name !== 'string' || name.trim().length === 0)) {
    throw new EvalJudgeDeclarationError('--judge needs a nonempty registry name.')
  }
  if (names.length > JUDGE_CONFIG.maxPanelMembers) {
    throw new EvalJudgeDeclarationError(`Pass at most ${JUDGE_CONFIG.maxPanelMembers} --judge names.`)
  }
  return [...names]
}

function evalJudgeNames(config: EvalCliConfig): readonly string[] {
  return selectedEvalJudgeNames(config.judges ?? config.judge)
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
  /** Every declared secrets-file value as `[secret:<name>]`. */
  mask: MaskFn
  executionContext: RunExecutionContext
}

/**
 * Resolve the one eval session. Validates the config through resolveConfig, takes replay's
 * settings from its flags alone, loads the workspace secrets file into a SecretStore and masks
 * with the declared secrets alone. Config errors are typed Errors naming the offending path,
 * never process.exit.
 */
export async function resolveEvalSession(input: {
  configPath?: string
  flags?: EvalSessionFlags
} = {}): Promise<EvalSession> {
  const configPath = input.configPath ?? 'agent-qa.config.yaml'
  const configDir = dirname(resolve(configPath))
  const evalConfig = evalConfigFromFlags(input.flags)
  const config = await resolveConfig({ configPath })

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

// The only sweep-shape failure, exit 1; per-item load failures are data, never errors.
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

// The extract verb's one DTO; the console renders from it, never around it.
export interface ExtractVerbResult {
  /** Run dirs (with a handoff document) that entered the sweep after `--run` narrowing. */
  runsSwept: number
  // Per-run typed skips for unreadable or version-refused handoffs, never batch errors.
  runsSkipped: { runSlug: string; reason: string }[]
  /** Runs whose product partition differed from `--product`. */
  runsFiltered: number
  cassettesWritten: number
  // Extraction report counters folded verbatim, keyed by the engine's own names.
  completeness: Record<string, number>
  cassettesRoot: string
}

// Selection, completeness and dedup belong to the engines; the CLI adds none of them.
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
      // The version-guarded loader is the one handoff read path; failures become per-run skips.
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

// ---- the replay verb ----------------------------------------------------------------------------

// Judge honesty counters folded from the persisted score records, never recomputed.
export interface ReplayJudgeCounters {
  /** Whether a `--judge` name entered the batch. */
  configured: boolean
  invoked: number
  settled: number
  abstained: number
  errors: number
  notInvoked: number
}

/** The replay verb's one DTO; the console renders from it and `--json` prints it. */
export interface ReplayVerbResult {
  // sha256 hex over the sorted replayed cassette ids, or `empty` for a zero batch.
  batchKey: string
  /** Bundle dirs that entered the sweep (pre-load, pre-filter). */
  swept: number
  /** Cassettes that replayed to a ReplayResult through the sanctioned composition. */
  replayed: number
  /** Typed loadCassetteBundle refusals folded by reason — data, never batch errors. */
  loadRefusals: Record<string, number>
  /** Typed replay refusals (plus harness errors) folded by reason — the batch never aborts. */
  replayRefusals: Record<string, number>
  /** Persisted score.json records read back after the loop (refusals are never scored). */
  scored: number
  /** Judge dispositions read from the persisted tie/settled stamps. */
  judge: ReplayJudgeCounters
  /** The staged replay-records root the persisted outcomes landed under. */
  replaysRoot: string
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
): ReplayInvocationSpend {
  const report = buildEvalReport(entries, undefined, undefined, { declaredSeed: seed })
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
 * The replay verb pipeline: sweep every staged cassette bundle under `.agent-qa/eval/cassettes`
 * (or the ones the filters name), load each through loadCassetteBundle (typed refusals as data),
 * and drive runCassetteReplay with the production planner profile, the session's declared mask,
 * the configured judges and the replay and score stores. Each cassette is scored against the
 * label its run recorded. After the loop the judge counters are folded from the persisted score
 * records. `opts` is the test seam for createModel overrides; judge, k and seed arrive from
 * replay's flags on `session.evalConfig`.
 */
export async function runReplayVerb(
  session: EvalSession,
  filters: { run?: string; cassette?: string; product?: string } = {},
  opts: {
    plannerOverrides?: ModelProviderOverrides
    judgeOverrides?: ModelProviderOverrides
  } = {},
): Promise<ReplayVerbResult> {
  const started = performance.now()
  const agentQaRoot = resolve(session.configDir, '.agent-qa')
  const cassettesRoot = join(agentQaRoot, DEFAULT_EVAL_CASSETTES_SUBDIR)
  const replaysRoot = join(agentQaRoot, DEFAULT_EVAL_REPLAYS_SUBDIR)

  // (1)+(2) sweep + load: every bundle dir enters; refusals fold by reason.
  const { swept, loaded, loadRefusals } = loadCassetteBundles(cassettesRoot)

  // (3) filters on the loaded set; a named miss is the only throw.
  let selected = loaded
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
  const zeroJudge = (configured: boolean): ReplayJudgeCounters => ({
    configured,
    invoked: 0,
    settled: 0,
    abstained: 0,
    errors: 0,
    notInvoked: 0,
  })

  // An empty batch is exit-0 data and spends no planner or judge resolution.
  if (selected.length === 0) {
    notices.push('empty sweep — no staged cassette bundles matched')
    return {
      batchKey: 'empty',
      swept,
      replayed: 0,
      loadRefusals,
      replayRefusals: {},
      scored: 0,
      judge: zeroJudge(evalJudgeNames(session.evalConfig).length > 0),
      replaysRoot,
      notices,
      spend: replayInvocationSpend([], session.evalConfig.seed, 0, started),
    }
  }

  const batchKey = computeBatchKey(selected.map(entry => entry.cassette.id))

  // (5) planner + judge through the run-parity named-LLM chain. resolveEvalJudge takes ONE
  // argument: the `--judge` names are already on session.evalConfig.
  const planner = await resolveReplayPlanner(session)
  const judgeResolution = await resolveEvalJudge(session)
  if (judgeResolution.notice !== undefined) notices.push(judgeResolution.notice)

  // The replay loop, in sorted id order.
  const recordStore = new FsReplayRecordStore({ root: agentQaRoot })
  const scoreStore = new FsScoreStore({ root: agentQaRoot })
  let modelCalls = 0
  const { replayed, replayRefusals, replayedDirs, notices: replayNotices } =
    await sweepCassetteReplays({
      selected,
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

  // Judge dispositions are folded from the persisted score records, never recomputed.
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
  const spendBatch = assembleScoredBatch({ replaysRoot, cassettesRoot, recordDirs: replayedDirs })
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
    notices,
    spend: replayInvocationSpend(spendBatch.entries, session.evalConfig.seed, modelCalls, started),
  }
}

// The exact `buildEvalReport` disposition read, scalar-summed for the summary surface.
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
 * Resolve the `--judge` names. No `--judge` is a typed no-judge notice — unresolved ties will
 * record not-invoked. A resolvable judge flows through the named-LLM chain; a judge whose model
 * family equals the planner's family — or resolves to no family at all — carries a
 * stderr-destined warning notice. The preflight is SOFT: assessJudgeEligibility inside
 * runCassetteReplay stays the per-cassette authority.
 *
 * `--judge-allow-same-family` is threaded verbatim onto the judge bundle's allowSameFamily; a
 * KNOWN-same-family pair then yields an advisory instead of the refusal warning. Unknown
 * families keep the refusal-style notice regardless — the flag never relaxes unknown ⇒ forbidden.
 */
export async function resolveEvalJudge(session: EvalSession): Promise<{
  judge?: import('@vostride/agent-qa-eval-local').RunCassetteReplayInput['judge']
  notice?: string
}> {
  const names = evalJudgeNames(session.evalConfig)
  if (names.length === 0) {
    return {
      notice: 'no --judge given — unresolved ties will record not-invoked{no-judge-configured}',
    }
  }

  if (names.length > 1) {
    const members = []
    for (const name of names) members.push(await resolveNamedProfile(name, session.configPath))
    return { judge: { members }, ...(session.evalConfig.judgeAllowSameFamily === true
      ? {
          notice: '--judge-allow-same-family is ignored for a judge panel; every member must come '
            + 'from a different family than the planner.',
        }
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
        `same-family judging allowed (--judge-allow-same-family): judge model ` +
        `"${resolved.profile.model}" and planner model "${planner.profile.model}" share the ` +
        `judge family '${judgeFamily}'; every scored entry discloses ` +
        'familyOverride: same-family-allowed',
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

// The same named-config chain `run` uses; an absent `use.llm` is a typed error.
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

// ---- the report verb ----------------------------------------------------------------------------

/** The report verb's one DTO; the console renders from it and `--json` prints it. */
export interface ReportVerbResult {
  /** sha256hex over the sorted assembled cassette ids, minted by buildEvalReport. */
  batchKey: string
  /** Records assembled this invocation, including refusals. */
  entries: number
  /** The one EvalBatchReport over the whole batch: one buildEvalReport call, one headline. */
  report: EvalBatchReport
  /** The staged report file under `.agent-qa/eval/reports`. */
  stagedFile: string
  /** Batch-level judge identity: consistent blocks pass through; mixed/absent surface honestly. */
  judgeIdentity: 'present' | 'absent' | 'mixed'
  /** Stderr-destined notices: read refusals, missing bundles, judge identity honesty. */
  notices: string[]
}

/**
 * The report verb pipeline: assemble one batch from every persisted replay record under
 * `.agent-qa/eval/replays`, joined to its score, judge identity and the staged cassette's label
 * leg. A persisted refusal outcome is an entry, never dropped. Judge identity threads from the
 * persisted score records: consistent blocks pass to buildEvalReport, mixed or absent identities
 * surface honestly and are never fabricated. Exactly one buildEvalReport call aggregates, and the
 * report is saved once through FsReportStore.
 */
export async function runReportVerb(
  session: EvalSession,
  filters: { run?: string; cassette?: string; product?: string } = {},
): Promise<ReportVerbResult> {
  const agentQaRoot = resolve(session.configDir, '.agent-qa')
  const replaysRoot = join(agentQaRoot, DEFAULT_EVAL_REPLAYS_SUBDIR)
  const cassettesRoot = join(agentQaRoot, DEFAULT_EVAL_CASSETTES_SUBDIR)
  const notices: string[] = []

  // (1)+(2) Join every persisted replay record to its score, judge identity and cassette label.
  const {
    entries: assembled,
    judgeBlocks,
    partitionsById,
    missingBundleCount,
    notices: assemblyNotices,
  } = assembleScoredBatch({ replaysRoot, cassettesRoot })
  notices.push(...assemblyNotices)
  if (missingBundleCount > 0) {
    notices.push(
      `${missingBundleCount} replay record(s) have no staged cassette bundle — label legs absent`,
    )
  }

  // (3) The replay filter vocabulary: a named miss is the only throw.
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

  // (4) Batch judge identity from the persisted blocks only: all defined blocks canonicalJson-equal
  // means the identity passes through; none means honest absence; differing blocks mean 'mixed'
  // and the report carries no judge block, only the distinct persisted ids.
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

  // (5) Exactly one buildEvalReport call; every counter and rate is the aggregator's.
  const report = buildEvalReport(entries, judgeForReport, mixedIdentity)
  const staged = new FsReportStore({ root: agentQaRoot }).save(report)

  return {
    batchKey: report.batchKey,
    entries: entries.length,
    report,
    stagedFile: staged.file,
    judgeIdentity,
    notices,
  }
}

// ---- internals --------------------------------------------------------------------------------

// Shared by judge and planner; `missing` auth throws a typed error naming `agent-qa auth login`.
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

// The run module's secrets recipe with typed errors, because this path may not call `process.exit`.
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

/** Replay's settings from its flags alone; the config file carries none. */
function evalConfigFromFlags(flags?: EvalSessionFlags): EvalCliConfig {
  const names = selectedEvalJudgeNames(flags?.judge)
  return {
    ...(names.length === 1 ? { judge: names[0] } : names.length > 1 ? { judges: names } : {}),
    ...(flags?.judgeAllowSameFamily === true ? { judgeAllowSameFamily: true } : {}),
    ...(flags?.k !== undefined ? { k: flags.k } : {}),
    ...(flags?.seed !== undefined ? { seed: flags.seed } : {}),
  }
}
// The feedback wording host reaches the model and the safety scope through this composition boundary.
export { runSafetyScope } from '@vostride/agent-qa-safety-local'
export { createModel } from '@vostride/agent-qa-model'
export type { AgentQaConfig as FeedbackWordingConfig } from '@vostride/agent-qa-core'
