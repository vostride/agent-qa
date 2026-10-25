import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  activeMarkedCorpusEntries, canonicalJson, composeBaselineProfileKey, computeDecisionIdentity,
  isUnjudgedPanelRefusal,
  createScoringContext, deriveRunSlug, representativeDecisionSample, resolveJudgeCalibrationTruth,
  resolveProductPartition, selectJudgeCalibrationGold,
  type BaselineProfileKeyInput, type JudgeCalibrationDiagnostics, type JudgeCalibrationEvidence,
  type JudgeCalibrationGold, type JudgeCalibrationSkipReason, type JudgeTargetedCalibrationMember,
  type LeafReplayResult,
} from '@vostride/agent-qa-eval'
import { HANDOFF_FILE, RUNS_SUBDIR, loadCompletedRunHandoff } from '@vostride/agent-qa-runner-local'
import { sha256hex, slugBranch } from '@vostride/agent-qa-schema'
import { baselineReplaySchema, baselineScoreSchema } from './baseline-cache-guards.js'
import { listBaselineRunRoots } from './baseline-cache-read.js'
import { assertCalibrationPath } from './calibration-source.js'
import { readCommittedCorpus, readRunExclusions } from './committed-corpus-source.js'
import { loadStagedReport } from './report-store.js'
import type { ScoreRecord } from './score-store.js'

export interface LoadJudgeCalibrationEvidenceInput {
  committedRoot: string
  agentQaRoot: string
  profile: BaselineProfileKeyInput
  /** Explicit operator selection when supplied; never choose the newest matching directory. */
  replayRunRoots?: readonly string[]
}
export interface JudgeCalibrationEvidenceRead {
  /** Executable selected gold before saved-replay admission; not a sum of skip diagnostics. */
  selected: number
  evidence: JudgeCalibrationEvidence[]
  skippedCounts: JudgeCalibrationDiagnostics
  corpusDigest: string
  goldSetDigest: string
  replayEvidenceDigest: string
  evidenceDigest: string
  profileKey: string
  selectedInputs: { decisionId: string; goldCassetteId: string; replayFile: string; reportFile: string; replayDigest: string; scoreDigest: string; reportDigest: string }[]
  /**
   * 422 D-12: the committed ADVERSARIAL population — the bait disclosure's source, never gold.
   *
   * ABSENT means this reader could not open the committed corpus at all, which is a different
   * fact from a corpus that holds no adversarial member; an empty array standing in for the
   * former would report a clean zero nobody measured.
   */
  adversarialMembers?: readonly JudgeTargetedCalibrationMember[]
}
const hash = (value: unknown) => sha256hex(canonicalJson(value))

/** Preflight every file a delegated reader might open, including dangling links. */
function inspectTree(root: string, path: string): void {
  assertCalibrationPath(root, path)
  if (!existsSync(path)) return
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    assertCalibrationPath(root, child)
    if (entry.isDirectory()) inspectTree(root, child)
  }
}

/** Operator-only IO. Every action/truth derivation stays in the neutral package. */
export function loadJudgeCalibrationEvidence(input: LoadJudgeCalibrationEvidenceInput): JudgeCalibrationEvidenceRead {
  const skippedCounts: JudgeCalibrationDiagnostics = {}
  const skip = (reason: JudgeCalibrationSkipReason) => { skippedCounts[reason] = (skippedCounts[reason] ?? 0) + 1 }
  const result: JudgeCalibrationEvidenceRead = { selected: 0, evidence: [], skippedCounts, corpusDigest: hash([]),
    goldSetDigest: hash([]), replayEvidenceDigest: hash([]), evidenceDigest: hash([]),
    profileKey: composeBaselineProfileKey(input.profile), selectedInputs: [] }
  const finish = () => {
    result.replayEvidenceDigest = hash(result.selectedInputs)
    result.evidenceDigest = hash({ profileKey: result.profileKey, corpusDigest: result.corpusDigest,
      goldSetDigest: result.goldSetDigest, replayEvidenceDigest: result.replayEvidenceDigest,
      evidence: result.evidence, skippedCounts })
    return result
  }
  try { inspectTree(input.committedRoot, input.committedRoot) }
  catch { skip('path-refused'); return finish() }
  const raw = readCommittedCorpus(input.committedRoot)
  // Set the moment the corpus IS readable, and never before: every path above returns with the
  // field still absent, which is what keeps "could not open" distinct from "holds no bait".
  result.adversarialMembers = raw.snapshot.entries
    .filter(entry => entry.split === 'adversarial')
    .map(entry => ({ cassetteId: entry.cassetteId, generator: entry.generator }))
  for (const _refusal of raw.refusals) skip('corpus-refused')
  const exclusions = readRunExclusions(input.committedRoot)
  if (exclusions.refusals.length) {
    for (const _refusal of exclusions.refusals) skip('corpus-refused')
    return finish()
  }
  const excluded = new Set(raw.snapshot.excludedLabelIds)
  for (const exclusion of exclusions.exclusions) {
    for (const [id, cassette] of raw.snapshot.cassettesById) if (cassette.runId === exclusion.runId) excluded.add(id)
  }
  const runIds = [...new Set([...raw.snapshot.labelsById.values()].map(label => label.provenance.runId))].sort()
  for (const runId of runIds) {
    const run = join(input.agentQaRoot, RUNS_SUBDIR, deriveRunSlug(runId))
    const excludeRun = () => {
      for (const [id, cassette] of raw.snapshot.cassettesById) if (cassette.runId === runId) excluded.add(id)
    }
    try {
      assertCalibrationPath(input.agentQaRoot, join(run, HANDOFF_FILE))
    } catch { skip('path-refused'); excludeRun(); continue }
    try {
      const handoff = loadCompletedRunHandoff(join(run, HANDOFF_FILE))
      if (handoff.runId !== runId || new Set(handoff.tests.map(member => member.testIndex)).size !== handoff.tests.length) throw new Error('foreign handoff')
      for (const [id, cassette] of raw.snapshot.cassettesById) {
        if (cassette.runId !== runId) continue
        const member = handoff.tests.find(row => row.testIndex === cassette.testIndex)
        const steps = member?.steps.filter(step => step.stepIndex === cassette.stepIndex)
        if (!member || member.testId !== cassette.testId || steps?.length !== 1
          || steps[0]!.subActions[cassette.decisionOrdinal] === undefined
          || raw.snapshot.entries.filter(entry => entry.cassetteId === id).some(entry => entry.product !== resolveProductPartition(handoff.scope))) {
          skip('handoff-refused'); excluded.add(id)
        }
      }
    } catch { skip('handoff-refused'); excludeRun() }
  }
  const snapshot = { ...raw.snapshot, entries: activeMarkedCorpusEntries(raw.snapshot, []), excludedLabelIds: excluded }
  const selection = selectJudgeCalibrationGold({ snapshot, marks: [] })
  result.selected = selection.gold.length
  Object.assign(skippedCounts, selection.skippedCounts)
  result.corpusDigest = selection.corpusDigest
  result.goldSetDigest = selection.goldSetDigest
  let runRoots: readonly string[]
  const coordinates = new Map<string, { index: number; seed?: number }>()
  try {
    // Guard parents before listBaselineRunRoots opens a profile directory.
    for (const kind of ['gate', 'floor']) assertCalibrationPath(input.agentQaRoot,
      join(input.agentQaRoot, 'eval', kind, slugBranch(result.profileKey)))
    runRoots = input.replayRunRoots ?? listBaselineRunRoots(input.agentQaRoot, result.profileKey).map(run => run.root)
    for (const root of runRoots) inspectTree(input.agentQaRoot, root)
  } catch { skip('path-refused'); return finish() }
  if (input.replayRunRoots === undefined) {
    const floor = join(input.agentQaRoot, 'eval', 'floor', slugBranch(result.profileKey))
    const indices = new Set<number>()
    for (const entry of existsSync(floor) ? readdirSync(floor, { withFileTypes: true }) : []) {
      const match = /^r(0|[1-9]\d*)-seed(0|-?[1-9]\d*)$/.exec(entry.name)
      const index = Number(match?.[1]), seed = Number(match?.[2])
      if (!entry.isDirectory() || !match || !Number.isSafeInteger(index) || !Number.isSafeInteger(seed) || indices.has(index)) {
        skip('ambiguous-replay'); return finish()
      }
      indices.add(index)
      coordinates.set(join(floor, entry.name), { index, seed })
    }
    coordinates.set(join(input.agentQaRoot, 'eval', 'gate', slugBranch(result.profileKey)), { index: Infinity })
  }
  const publications = [...new Set(runRoots)].sort().flatMap(root => {
    const directory = join(root, 'reports')
    if (!existsSync(directory)) return []
    return readdirSync(directory).filter(name => /^[^.]+\.json$/.test(name)).sort().map(name => ({
      root, load: loadStagedReport(input.agentQaRoot, name.slice(0, -5), directory),
    }))
  })
  if (input.replayRunRoots === undefined && publications.some(publication => publication.load.kind !== 'loaded')) {
    skip('missing-profile-proof'); return finish()
  }
  for (const gold of selection.gold) {
    const candidates: { root: string; evidence: JudgeCalibrationEvidence; identity: JudgeCalibrationEvidenceRead['selectedInputs'][number] }[] = []
    const failures = new Set<JudgeCalibrationSkipReason>()
    let missingPublishedReplay = false
    for (const root of [...new Set(runRoots)].sort()) {
      const dir = join(root, 'replays', ...gold.goldCassetteId.split('/').map(slugBranch))
      const replayFile = join(dir, 'replay.json'), scoreFile = join(dir, 'score.json')
      let replay: LeafReplayResult, score: ScoreRecord
      try {
        assertCalibrationPath(input.agentQaRoot, replayFile)
        assertCalibrationPath(input.agentQaRoot, scoreFile)
      } catch { failures.add('path-refused'); continue }
      if (!existsSync(replayFile)) {
        const claimed = publications.some(publication => publication.root === root && publication.load.kind === 'loaded'
          && publication.load.replayGeneration?.records.some(row => row.cassetteId === gold.goldCassetteId))
        missingPublishedReplay ||= claimed
        failures.add('missing-replay'); continue
      }
      try {
        const value: unknown = JSON.parse(readFileSync(replayFile, 'utf8'))
        if (!baselineReplaySchema.safeParse(value).success || !value || typeof value !== 'object'
          || !('granularity' in value) || value.granularity !== 'leaf') { failures.add('malformed-replay'); continue }
        replay = value as LeafReplayResult
      } catch { failures.add('malformed-replay'); continue }
      if (replay.cassetteId !== gold.goldCassetteId || replay.replayedModel.modelId !== input.profile.plannerModelId
        || replay.promptDrift.recordedHash !== gold.cassette.receipt.promptInputHash
        || replay.promptDrift.harnessDrift || replay.promptDrift.declaredDelta !== undefined
        || replay.promptDrift.recomputedHash !== gold.cassette.receipt.promptInputHash
        || replay.samples.some(sample => sample.outcome.kind === 'decision' && canonicalJson(sample.outcome.identity)
          !== canonicalJson(computeDecisionIdentity(sample.outcome.action, gold.cassette.input.stateBefore.elements)))) {
        failures.add('foreign-replay'); continue
      }
      if (replay.agreement.noConsensus) { failures.add('ambiguous-replay'); continue }
      const modal = replay.agreement.modal
      const matchingSamples = replay.samples.filter(sample => sample.outcome.kind === 'decision'
        && canonicalJson(sample.outcome.identity) === canonicalJson(modal?.identity))
      if (!modal || modal.count !== matchingSamples.length
        || replay.agreement.agreementRate !== modal.count / replay.samples.length
        || canonicalJson(replay.modalDecision) !== canonicalJson(modal.identity)) {
        failures.add('malformed-replay'); continue
      }
      try {
        const value: unknown = JSON.parse(readFileSync(scoreFile, 'utf8'))
        if (!baselineScoreSchema.safeParse(value).success) { failures.add('stale-replay'); continue }
        score = value as ScoreRecord
      } catch { failures.add('stale-replay'); continue }
      if (!score.scoringContext || score.cassetteId !== gold.goldCassetteId
        || score.matcherVersion !== input.profile.matcherVersion
        || score.score.kind !== 'leaf' || score.score.entry.decisionOrdinal !== gold.cassette.decisionOrdinal
        || (score.score.entry.kind !== 'skipped' && score.score.entry.stepIndex !== undefined && score.score.entry.stepIndex !== gold.cassette.stepIndex)
        || canonicalJson(createScoringContext({ cassette: gold.cassette, labelRecord: gold.labelRecord,
          outcome: replay, score: score.score, judge: score.judge, judgeRequest: score.scoringContext.judgeRequest })) !== canonicalJson(score.scoringContext)) {
        failures.add('stale-replay'); continue
      }
      const replayDigest = hash(replay), scoreDigest = hash(score)
      const unjudgedRefusal = isUnjudgedPanelRefusal({ record: score, profile: input.profile,
        recordedModel: gold.recordedReceipt.receipt.model, replayedModelId: replay.replayedModel.modelId })
      const proofs = publications.filter(publication => publication.root === root && publication.load.kind === 'loaded')
      if (publications.some(publication => publication.root === root && publication.load.kind !== 'loaded')) failures.add('missing-profile-proof')
      let matched = false
      for (const publication of proofs) {
        const loaded = publication.load
        if (loaded.kind !== 'loaded') continue
        const { report, replayGeneration } = loaded
        if (report.runIdentity?.fingerprint !== input.profile.fingerprint
          || report.matcherVersion !== input.profile.matcherVersion || report.judgeIdentity === 'mixed'
          || (!(unjudgedRefusal && report.judge === undefined) &&
            (report.judge?.judgeModelId !== input.profile.judgeModelId || report.judge?.judgeVersion !== input.profile.judgeVersion))
          || (!unjudgedRefusal && (score.judge?.judgeModelId !== input.profile.judgeModelId || score.judge?.judgeVersion !== input.profile.judgeVersion))
          || (input.profile.judgeModelId?.startsWith('panel:') && canonicalJson(score.scoringContext.judgeRequest)
            !== canonicalJson({ judgeModelId: input.profile.judgeModelId, allowSameFamily: false }))) {
          failures.add('foreign-profile'); continue
        }
        if (report.runIdentity.corpusDigest !== result.corpusDigest) { failures.add('stale-replay'); continue }
        if (!replayGeneration) { failures.add('missing-profile-proof'); continue }
        if (coordinates.get(root)?.seed !== undefined && coordinates.get(root)!.seed !== replayGeneration.seed) {
          failures.add('foreign-replay'); continue
        }
        const refs = replayGeneration.records.filter(row => row.cassetteId === gold.goldCassetteId)
        if (refs.length !== 1 || refs[0]!.replayDigest !== replayDigest || refs[0]!.scoreDigest !== scoreDigest
          || Reflect.get(replay, 'executionSeed') !== replayGeneration.seed) { failures.add('stale-replay'); continue }
        const candidate = representativeDecisionSample(replay)
        if (!candidate) { failures.add('missing-candidate'); continue }
        matched = true
        candidates.push({ root, evidence: evidenceRow(gold, candidate, replay, result.profileKey, replayDigest),
          identity: { decisionId: gold.decisionId, goldCassetteId: gold.goldCassetteId, replayFile,
            reportFile: loaded.file, replayDigest, scoreDigest, reportDigest: hash(report) } })
      }
      if (!matched && proofs.length === 0) failures.add('missing-profile-proof')
    }
    // Auto-selection samples the producer's first global schedule slot, never the verdict.
    // Every present row must pass admission; malformed history cannot become a gate fallback.
    if (input.replayRunRoots === undefined) {
      const invalid = [...failures].filter(reason => reason !== 'missing-replay' || missingPublishedReplay)
      if (invalid.length) { for (const reason of invalid.sort()) skip(reason); continue }
      if (new Set(candidates.map(candidate => candidate.root)).size !== candidates.length) {
        skip('ambiguous-replay'); continue
      }
      candidates.sort((a, b) => coordinates.get(a.root)!.index - coordinates.get(b.root)!.index)
      if (candidates.length > 1) candidates.splice(1)
    }
    if (candidates.length !== 1) {
      if (candidates.length > 1) skip('ambiguous-replay')
      else if (failures.size) for (const reason of [...failures].sort()) skip(reason)
      else skip('missing-replay')
      continue
    }
    result.evidence.push(candidates[0]!.evidence)
    result.selectedInputs.push(candidates[0]!.identity)
  }
  return finish()
}

function evidenceRow(gold: JudgeCalibrationGold, candidate: JudgeCalibrationEvidence['candidate'], replay: LeafReplayResult,
  profileKey: string, replayDigest: string): JudgeCalibrationEvidence {
  return { ...gold, candidate, replayedModelId: replay.replayedModel.modelId, profileKey, replayDigest,
    truth: resolveJudgeCalibrationTruth({ gold, candidate }) }
}
