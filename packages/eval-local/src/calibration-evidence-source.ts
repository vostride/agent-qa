import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { calibrationGoldSetDigest, canonicalJson, deriveRunSlug, resolveProductPartition, type CalibrationObservation, type GoldMark, type LabelCalibrationInput } from '@vostride/agent-qa-eval'
import { HANDOFF_FILE, RUNS_SUBDIR, loadCompletedRunHandoff } from '@vostride/agent-qa-runner-local'
import { ANALYSIS_FILE, admitAnalysisArtifactForRun, guardRunAnalysisArtifact, type CompletedRunHandoff } from '@vostride/agent-qa-schema'
import { readActiveCommittedCorpus, readCommittedCorpus } from './committed-corpus-source.js'
import { assertCalibrationPath, type LabelCalibrationRead } from './calibration-source.js'

export type CalibrationEvidenceMissingReason = 'corpus-refused' | 'invalid-run-link' | 'path-refused'
  | 'handoff-missing' | 'handoff-unreadable' | 'handoff-refused'
  | 'source-refused' | 'deterministic-missing' | 'deterministic-refused' | 'analysis-missing'
  | 'analysis-unreadable' | 'analysis-refused' | 'analyze-run-missing'
export interface CalibrationEvidenceRead extends LabelCalibrationInput {
  marks: GoldMark[]
  observations: CalibrationObservation[]
  missingEvidenceCounts: Partial<Record<CalibrationEvidenceMissingReason, number>>
}

function contained(root: string, path: string): boolean {
  const rel = relative(realpathSync(root), realpathSync(path))
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Guard persisted observations independently; a winning merged verdict loses producer evidence. */
export function loadCalibrationEvidence(input: { committedRoot: string; agentQaRoot: string; calibrationRead?: LabelCalibrationRead }): CalibrationEvidenceRead {
  const missingEvidenceCounts: CalibrationEvidenceRead['missingEvidenceCounts'] = {}
  const missing = (reason: CalibrationEvidenceMissingReason) => {
    missingEvidenceCounts[reason] = (missingEvidenceCounts[reason] ?? 0) + 1
  }
  const raw = readCommittedCorpus(input.committedRoot, input.calibrationRead)
  const links = new Map<string, { products: Set<string>; invalid: boolean }>()
  for (const entry of raw.snapshot.entries) {
    const { runId, runSlug } = entry.run_links
    const link = links.get(runId) ?? { products: new Set<string>(), invalid: false }
    link.products.add(entry.product)
    link.invalid ||= runSlug !== deriveRunSlug(runId)
    links.set(runId, link)
  }
  // A run that only labels reference still contributes its observations.
  for (const label of raw.snapshot.labelsById.values()) if (!links.has(label.provenance.runId)) {
    links.set(label.provenance.runId, { products: new Set<string>(), invalid: label.provenance.runSlug !== deriveRunSlug(label.provenance.runId) })
  }
  const active = readActiveCommittedCorpus(input.committedRoot, input.agentQaRoot, input.calibrationRead)
  for (const _refusal of active.refusals) missing('corpus-refused')
  const result: CalibrationEvidenceRead = { snapshot: active.snapshot, marks: [], observations: [], missingEvidenceCounts }
  const excluded = new Set(active.snapshot.excludedLabelIds)
  const excludeSources = (runId: string) => {
    for (const [id, label] of active.snapshot.labelsById) if (label.provenance.runId === runId && !label.provenance.sourceCassetteId) excluded.add(id)
  }
  for (const [runId, link] of [...links].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (link.invalid) { missing('invalid-run-link'); excludeSources(runId); continue }
    const run = join(input.agentQaRoot, RUNS_SUBDIR, deriveRunSlug(runId))
    const handoffPath = join(run, HANDOFF_FILE)
    if (!existsSync(handoffPath)) { missing('handoff-missing'); excludeSources(runId); continue }
    let handoff: CompletedRunHandoff
    try {
      if (!contained(input.agentQaRoot, handoffPath)) { missing('path-refused'); excludeSources(runId); continue }
      handoff = loadCompletedRunHandoff(handoffPath)
    } catch { missing('handoff-unreadable'); excludeSources(runId); continue }
    const indices = handoff.tests.map(member => member.testIndex)
    if (handoff.runId !== runId || !indices.every(index => Number.isSafeInteger(index) && index >= 0)
      || new Set(indices).size !== indices.length
      || [...link.products].some(product => product !== resolveProductPartition(handoff.scope))) {
      missing('handoff-refused'); excludeSources(runId); continue
    }
    for (const [id, cassette] of active.snapshot.cassettesById) {
      if (cassette.runId !== runId) continue
      const member = handoff.tests.find(test => test.testIndex === cassette.testIndex)
      if (!member || member.testId !== cassette.testId || !member.steps.some(step => step.stepIndex === cassette.stepIndex)) {
        missing('source-refused'); excluded.add(id)
      }
    }
    for (const member of handoff.tests) {
      const verdict = member.rootCause
      if (!verdict) { missing('deterministic-missing'); continue }
      if (verdict.producer !== 'deterministic-classifier' || verdict.perTest !== member.testIndex) {
        missing('deterministic-refused'); continue
      }
      result.observations.push({ runId, testIndex: member.testIndex, producer: verdict.producer, class: verdict.class })
    }
    const analysisPath = join(run, ANALYSIS_FILE)
    if (!existsSync(analysisPath)) { missing('analysis-missing'); continue }
    try {
      if (!contained(input.agentQaRoot, analysisPath)) { missing('path-refused'); continue }
      const admission = admitAnalysisArtifactForRun(guardRunAnalysisArtifact(JSON.parse(readFileSync(analysisPath, 'utf8'))), runId)
      if (admission.kind !== 'admitted') { missing('analysis-refused'); continue }
      const authored = new Set<number>()
      for (const verdict of admission.artifact.verdicts) {
        if (verdict.producer !== 'analyze-run' || !indices.includes(verdict.perTest)) { missing('analysis-refused'); continue }
        authored.add(verdict.perTest)
        result.observations.push({ runId, testIndex: verdict.perTest, producer: verdict.producer, class: verdict.class })
      }
      for (const index of indices) if (!authored.has(index)) missing('analyze-run-missing')
    } catch { missing('analysis-unreadable') }
  }
  result.snapshot = { ...active.snapshot, excludedLabelIds: excluded }
  const compare = (a: unknown, b: unknown) => canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0
  result.observations.sort(compare)
  return result
}

/** Guarded diagnostic read using the caller's already validated calibration generation. */
export function readCalibrationGoldIdentity(input: {
  committedRoot: string; agentQaRoot: string; calibrationRead: LabelCalibrationRead
}): { kind: 'loaded'; goldSetDigest: string } | { kind: 'unavailable' } {
  if (input.calibrationRead.kind === 'refused') return { kind: 'unavailable' }
  try {
    assertCalibrationPath(input.committedRoot, input.committedRoot)
    const inspect = (directory: string): void => {
      assertCalibrationPath(input.committedRoot, directory)
      if (!existsSync(directory)) return
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'blobs') continue
        const path = join(directory, entry.name)
        assertCalibrationPath(input.committedRoot, path)
        if (entry.isDirectory()) inspect(path)
      }
    }
    for (const name of ['labels', 'corpus', 'cassettes']) inspect(join(input.committedRoot, name))
    const evidence = loadCalibrationEvidence(input)
    // Missing/invalid governing evidence cannot certify a current or stale identity.
    const unavailable = Object.entries(evidence.missingEvidenceCounts).some(([reason, n]) =>
      n && !['analysis-missing', 'analyze-run-missing', 'deterministic-missing'].includes(reason))
    if (unavailable) return { kind: 'unavailable' }
    return { kind: 'loaded', goldSetDigest: calibrationGoldSetDigest(evidence) }
  } catch { return { kind: 'unavailable' } }
}
