import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '@vostride/agent-qa-eval'
import { FsEvidenceArtifactStore } from '@vostride/agent-qa-runner-local'
import {
  asRunId,
  type Verdict,
  CURRENT_ANALYSIS_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { afterEach, expect, it } from 'vitest'
import * as local from '../index.js'
import { makeLocalV2Handoff, LOCAL_FIXTURE_BLOB_BYTES } from './fixtures/local-handoff-fixture.js'

const NO_DECLARED_SECRETS = (text: string) => text
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function verdict(producer: Verdict['producer'], classification: Verdict['class']): Verdict {
  return { perTest: 0, producer, class: classification, confidence: 1,
    evidence: { citedSteps: [], citedAnchors: [], citedArtifacts: [], rationale: 'fixture' }, memoryMisdirectionRuledOut: true }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'calibration-evidence-'))
  roots.push(root)
  const committedRoot = join(root, 'committed')
  const handoff = makeLocalV2Handoff({ runId: asRunId('calibration-local'), scope: { tier: 'product', key: 'shop' } })
  const member = handoff.tests[0]!
  member.steps = [member.steps[0]!, { ...structuredClone(member.steps[0]!), stepIndex: 1 }]
  member.rootCause = verdict('deterministic-classifier', 'app_bug')
  for (const step of member.steps) for (const sub of step.subActions) sub.stateBefore.timestamp = 1_725_000_000
  const run = join(root, 'runs', core.deriveRunSlug(handoff.runId))
  mkdirSync(run, { recursive: true })
  writeFileSync(join(run, 'handoff.json'), JSON.stringify(handoff))
  new FsEvidenceArtifactStore({ root, runId: handoff.runId }).persistDecisionScreenshot(LOCAL_FIXTURE_BLOB_BYTES)
  const cassettes = core.extractRunCassettes({ handoff, artifacts: new local.FsRunArtifactSource({ root, runId: handoff.runId }) }).cassettes
  const plan = core.buildSeedingPlan({ handoff, cassettes, partition: { saltHex: 'a'.repeat(64), heldOutFraction: 0.000001, privateFraction: 0.5 } })
  const seeded = local.seedCommittedCorpus({ plan, cassettes, committedRoot, mask: NO_DECLARED_SECRETS })
  if (seeded.refusals.length) throw new Error('Fixture seeding refused')
  const analysis = { schemaVersion: CURRENT_ANALYSIS_SCHEMA_VERSION, runId: handoff.runId, verdicts: [verdict('analyze-run', 'test_bug')], parts: [] }
  const saveAnalysis = () => writeFileSync(join(run, 'analysis.json'), JSON.stringify(analysis))
  saveAnalysis()
  const read = () => Reflect.get(local, 'loadCalibrationEvidence')?.({ committedRoot, agentQaRoot: root })
  return { root, run, committedRoot, handoff, analysis, saveAnalysis, read }
}

it('loads one observation per actual producer across multiple source steps', () => {
  const input = fixture(), evidence = input.read()
  expect(evidence?.observations).toHaveLength(2)
  expect(new Set(evidence.observations.map((row: core.CalibrationObservation) => row.producer))).toEqual(new Set(['analyze-run', 'deterministic-classifier']))
  expect(evidence.missingEvidenceCounts).toEqual({})
})
it.each(['missing', 'malformed', 'run-mismatch', 'producer-spoof', 'foreign-member', 'symlink'] as const)('discloses %s analysis while retaining deterministic evidence', mode => {
  const input = fixture(), path = join(input.run, 'analysis.json')
  if (mode === 'missing') rmSync(path)
  if (mode === 'malformed') writeFileSync(path, '{')
  if (mode === 'run-mismatch') { input.analysis.runId = asRunId('foreign'); input.saveAnalysis() }
  if (mode === 'producer-spoof') { input.analysis.verdicts[0]!.producer = 'deterministic-classifier'; input.saveAnalysis() }
  if (mode === 'foreign-member') { input.analysis.verdicts[0]!.perTest = 42; input.saveAnalysis() }
  if (mode === 'symlink') {
    const outside = mkdtempSync(join(tmpdir(), 'calibration-outside-'))
    roots.push(outside)
    writeFileSync(join(outside, 'analysis.json'), JSON.stringify(input.analysis))
    rmSync(path)
    symlinkSync(join(outside, 'analysis.json'), path)
  }
  const evidence = input.read()
  expect(evidence?.observations).toEqual([{ runId: input.handoff.runId, testIndex: 0, producer: 'deterministic-classifier', class: 'app_bug' }])
  expect(Object.values(evidence.missingEvidenceCounts).reduce((a: number, b) => a + Number(b), 0)).toBeGreaterThan(0)
})
it.each(['identity', 'producer', 'member'] as const)('fails closed for invalid %s evidence', mode => {
  const input = fixture()
  if (mode === 'identity') input.handoff.runId = asRunId('foreign')
  if (mode === 'producer') input.handoff.tests[0]!.rootCause!.producer = 'analyze-run'
  if (mode === 'member') input.handoff.tests[0]!.rootCause!.perTest = 1
  writeFileSync(join(input.run, 'handoff.json'), JSON.stringify(input.handoff))
  const evidence = input.read()
  expect(evidence).toBeDefined()
  expect(evidence.observations.filter((row: core.CalibrationObservation) => row.producer === 'deterministic-classifier')).toEqual([])
  expect(Object.keys(evidence.missingEvidenceCounts).length).toBeGreaterThan(0)
})
it('discloses absent deterministic observation and rejects source steps absent from guarded handoff', () => {
  const input = fixture()
  delete input.handoff.tests[0]!.rootCause
  input.handoff.tests[0]!.steps.pop()
  writeFileSync(join(input.run, 'handoff.json'), JSON.stringify(input.handoff))
  const evidence = input.read()
  expect(evidence?.missingEvidenceCounts['deterministic-missing']).toBe(1)
  expect(evidence.missingEvidenceCounts['source-refused']).toBeGreaterThan(0)
  expect(evidence.observations.filter((row: core.CalibrationObservation) => row.producer === 'deterministic-classifier')).toEqual([])
})
