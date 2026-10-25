import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildSeedingPlan,
  extractRunCassettes,
  maskCorpusText,
  projectCorpusEntry,
  projectSilverLabelRecord,
  type ArtifactSource,
  type ExtractedCassette,
  type LeafCassette,
  type SeedingPlan,
} from '@vostride/agent-qa-eval'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import {
  asRunId,
  computeBriefDigest,
  distilledScreenStateDigest,
  slugBranch,
  type CompletedRunHandoff,
  type LosslessServedBriefProofV1,
  SERVED_BRIEF_PROOF_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { refreshAdversarialSplit, stageAdversarialProposal } from '../adversarial-composition.js'
import { admitStagedFeedback } from '../gate2-composition.js'
import { seedCommittedCorpus } from '../seeding-composition.js'
import { writeGate1Fixture } from './fixtures/gate1-fixtures.js'
import { writeStagedFeedback, type StagedFeedbackFixtureInput } from './fixtures/staged-feedback-fixture.js'
import {
  LOCAL_FIXTURE_BLOB_BYTES,
  LOCAL_FIXTURE_BLOB_SHA,
  makeLocalV2Handoff,
} from './fixtures/local-handoff-fixture.js'

const PROBE = 'hunter2-declared-441-probe'
const redactor = new SecretRedactor(SecretStore.fromEnvContent(`PROBE_441=${PROBE}\n`))
const mask = (text: string) => redactor.redactString(text)
const NO_DECLARED_SECRETS = (text: string) => text
const PARTITION = { saltHex: 'a3f'.repeat(21).concat('b'), heldOutFraction: 0.95, privateFraction: 0.5 } as const
const artifacts: ArtifactSource = {
  getBlob: sha => (sha === LOCAL_FIXTURE_BLOB_SHA ? LOCAL_FIXTURE_BLOB_BYTES : undefined),
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), '441-gap3-corpus-'))
  roots.push(root)
  return root
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  }).sort()
}

function holdingProbe(dir: string): string[] {
  return files(dir).filter(path => readFileSync(path).toString('utf8').includes(PROBE))
}

// The verifier's reproduction: a declared value in the D-18 screen state of the first step.
function probeHandoff(overrides: Partial<CompletedRunHandoff> = {}): CompletedRunHandoff {
  const handoff = makeLocalV2Handoff(overrides)
  const state = handoff.tests[0]!.steps[0]!.subActions[0]!.stateBefore
  state.tree = `${state.tree}\ntextbox "Access code": ${PROBE}`
  return handoff
}

function planFor(handoff: CompletedRunHandoff): { plan: SeedingPlan; cassettes: ExtractedCassette[] } {
  const cassettes = extractRunCassettes({ handoff, artifacts }).cassettes
  return { plan: buildSeedingPlan({ handoff, cassettes, partition: PARTITION }), cassettes }
}

function proof(): LosslessServedBriefProofV1 {
  return {
    schemaVersion: SERVED_BRIEF_PROOF_SCHEMA_VERSION, completeness: 'lossless', recordCap: 8, combinedBudget: 2048, admissionEvents: [],
    promptTurns: [{ ordinal: 0, turnOrdinal: 0, runDate: '2026-09-11', policyL0: 'policy', learnedL1: 'learned one',
      learnedL2: 'learned two', contextTier: 'context', volatileTier: 'volatile', policyDigest: '1'.repeat(64),
      contextTierDigest: '2'.repeat(64), volatileTierDigest: '3'.repeat(64) }],
  }
}

// gate2-composition.test.ts's admission fixture, with the declared value only in the target step's
// tree: the distilled digest reads route, roles and names, so the staged target stays the same.
function stagingFixture() {
  const root = tempRoot()
  const f = writeGate1Fixture(root, { targetInCorpus: false, handoffForTarget: true, proofBrief: true })
  const handoffPath = join(f.agentQaRoot, 'runs', slugBranch(f.injection.target!.runId), 'handoff.json')
  const handoff = JSON.parse(readFileSync(handoffPath, 'utf8')) as CompletedRunHandoff
  const step = handoff.tests[0]!.steps[0]!
  const line = step.servedBrief!.channel1[0]!
  line.status = 'candidate'
  line.servedAsCanary = true
  step.servedBrief!.briefDigest = computeBriefDigest(step.servedBrief!)
  const state = step.subActions[0]!.stateBefore
  state.url = 'https://feedback.example/gap3'
  state.timestamp = 1_725_000_000
  const stateDigest = distilledScreenStateDigest(state)
  state.tree = `${state.tree}\ntextbox "Access code": ${PROBE}`
  expect(distilledScreenStateDigest(state)).toBe(stateDigest)
  writeFileSync(handoffPath, JSON.stringify(handoff))
  const input: StagedFeedbackFixtureInput = { agentQaRoot: f.agentQaRoot,
    product: handoff.scope.key, target: { runId: String(handoff.runId), testId: handoff.tests[0]!.testId, stepIndex: 0 },
    attributedObservationId: 'gap3-feedback-observation', benefit: 'rode-along', candidateId: line.id, stateDigest }
  return { ...f, input }
}

describe('C441-GAP3-CORPUS', () => {
  it('the corpus writer refuses a case whose screen state still holds a declared value raw and writes none of it', () => {
    const committedRoot = join(tempRoot(), 'agent-qa-eval')
    const { plan, cassettes } = planFor(probeHandoff())
    expect(plan.cases).toHaveLength(1)

    const report = seedCommittedCorpus({ plan, cassettes, committedRoot, mask })

    expect(report.seededCount).toBe(0)
    expect(report.refusals).toEqual([{ cassetteId: plan.cases[0]!.cassetteId, kind: 'unmasked-declared-value' }])
    expect(holdingProbe(committedRoot)).toEqual([])
  })

  it('the same run masked before extraction seeds its case, and the committed cassette holds only the marker', () => {
    const committedRoot = join(tempRoot(), 'agent-qa-eval')
    const { plan, cassettes } = planFor(maskCorpusText(probeHandoff(), mask))

    const report = seedCommittedCorpus({ plan, cassettes, committedRoot, mask })

    expect(report.refusals).toEqual([])
    expect(report.seededCount).toBe(1)
    expect(holdingProbe(committedRoot)).toEqual([])
    expect(files(committedRoot).some(path => path.endsWith('cassette.json')
      && readFileSync(path, 'utf8').includes('[secret:PROBE_441]'))).toBe(true)
  })

  it('the corpus writer refuses a declared value left raw outside the step text, screen state and action', () => {
    const committedRoot = join(tempRoot(), 'agent-qa-eval')
    const handoff = maskCorpusText(probeHandoff(), mask)
    handoff.tests[0]!.steps[0]!.verifierVerdict = { pass: true, reasoning: `Accepted the code ${PROBE}` }
    const { plan, cassettes } = planFor(handoff)

    const report = seedCommittedCorpus({ plan, cassettes, committedRoot, mask })

    expect(report.seededCount).toBe(0)
    expect(report.refusals).toEqual([{ cassetteId: plan.cases[0]!.cassetteId, kind: 'unmasked-declared-value' }])
    expect(holdingProbe(committedRoot)).toEqual([])
  })

  it('seedCommittedCorpus without a mask throws before it writes anything', () => {
    const committedRoot = join(tempRoot(), 'agent-qa-eval')
    const { plan, cassettes } = planFor(maskCorpusText(probeHandoff(), mask))

    expect(() => seedCommittedCorpus({ plan, cassettes, committedRoot } as unknown as Parameters<typeof seedCommittedCorpus>[0]))
      .toThrow(TypeError)
    expect(existsSync(committedRoot)).toBe(false)
  })

  it('adversarial admission skips a staged case that still holds a declared value as unmasked-declared-value', async () => {
    const root = tempRoot()
    const committedRoot = join(root, 'committed')
    const agentQaRoot = join(root, '.agent-qa')
    mkdirSync(agentQaRoot, { recursive: true })
    // A pre-fix corpus: a seed committed with no declared mask, its screen state holding the value.
    const handoff = probeHandoff({ runId: asRunId('run / gap3 adversarial 00') })
    const member = handoff.tests[0]!
    member.steps = [member.steps[0]!]
    const brief = member.steps[0]!.servedBrief
    brief.proof = proof()
    brief.channel3 = [{ id: 'gap3-caution' as never, anchors: [], summary: 'served caution' }]
    brief.briefDigest = computeBriefDigest(brief)
    const extracted = extractRunCassettes({ handoff, artifacts }).cassettes.find(row => row.cassette.granularity === 'leaf')!
    const seed = extracted.cassette as LeafCassette
    expect(seedCommittedCorpus({
      plan: { product: 'default', runId: handoff.runId, runSlug: 'gap3-adversarial-00',
        cases: [{ cassetteId: seed.id, labelRecord: projectSilverLabelRecord({ cassette: seed, runId: handoff.runId }),
          corpusEntry: projectCorpusEntry({ cassette: seed, product: 'default', runId: handoff.runId, assignment: { split: 'natural' } }) }],
        pairSkips: [], silverExclusions: [], pairCounts: { total: 0, sameState: 0, differingState: 0 }, proceduresExcludedCount: 0 },
      cassettes: [{ cassette: seed, blobs: extracted.blobs }], committedRoot, mask: NO_DECLARED_SECRETS,
    }).refusals).toEqual([])
    const staged = await stageAdversarialProposal({ agentQaRoot, committedRoot, product: 'default', mutators: ['confusable'] })
    expect(staged.kind).toBe('staged')
    expect(staged.staged.length).toBeGreaterThan(0)
    const before = new Set(files(committedRoot))

    const admitted = refreshAdversarialSplit({ agentQaRoot, committedRoot, product: 'default', batchDigest: staged.batchDigest!, mask })

    expect(admitted.admitted).toEqual([])
    expect(admitted.stagingSkips.map(skip => skip.reason)).toEqual(staged.staged.map(() => 'unmasked-declared-value'))
    const written = files(committedRoot).filter(path => !before.has(path))
    expect(written.filter(path => readFileSync(path, 'utf8').includes(PROBE))).toEqual([])
  })

  it('a masked staged feedback entry is admitted, and the committed root holds no declared value', async () => {
    const f = stagingFixture()
    writeStagedFeedback({ ...f.input, mask })

    const admitted = await admitStagedFeedback({ agentQaRoot: f.agentQaRoot, committedRoot: f.committedRoot, dryRun: false, mask })

    expect(admitted.refusals).toEqual([])
    expect(admitted.admitted).toHaveLength(1)
    expect(holdingProbe(f.committedRoot)).toEqual([])
  })

  it('a feedback entry staged unmasked is refused at admission and commits nothing raw', async () => {
    const f = stagingFixture()
    writeStagedFeedback(f.input)

    const admitted = await admitStagedFeedback({ agentQaRoot: f.agentQaRoot, committedRoot: f.committedRoot, dryRun: false, mask })

    expect(admitted.admitted).toEqual([])
    expect(admitted.refusals.map(refusal => refusal.kind)).toEqual(['unmasked-declared-value'])
    expect(holdingProbe(f.committedRoot)).toEqual([])
  })
})
