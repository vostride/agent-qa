import { cpSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as model from '@vostride/agent-qa-model'
import { canonicalJson, collectSoftPopulation, committedFileText, computeCorpusDigest, createLabelRevision, deriveRunSlug } from '@vostride/agent-qa-eval'
import { committedLabelPath, loadLabelEvidence, readCommittedCorpus } from '@vostride/agent-qa-eval-local'
import { asRef, screenStateHash, sha256hex } from '@vostride/agent-qa-schema'
import { files, markFixture } from '../gates/__tests__/feedback-fixture.js'
import { resolveEvalSession, runSeedVerb } from '../eval-session-composition.js'

const roots: string[] = []
const fractions = { heldOutFraction: 0.4, privateFraction: 0.5 }
const bytes = (root: string) => files(root).map(path => [path, readFileSync(path).toString('hex')])
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('provider access forbidden') })
  vi.spyOn(model, 'createModel').mockImplementation(() => { throw new Error('model creation forbidden') })
})
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled()
  expect(model.createModel).not.toHaveBeenCalled()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(rerun = false) {
  const f = markFixture(); roots.push(f.root)
  writeFileSync(join(f.root, '.env.secrets.local'), '')
  const member = f.handoff.tests[0]!, step = member.steps[0]!
  member.outcome = 'healed'
  f.handoff.aggregateVerdict = 'healed'
  step.verifierVerdict = { pass: true, reasoning: 'Recovery verified' }
  step.modelProfile = { provider: 'openai', modelId: 'small-fixture', vision: true }
  const failed = step.subActions[0]!
  failed.callRecord = { resolvedModelId: 'wrong-failed-planner' }
  failed.result = { success: false, error: 'First action rejected' }
  const secondRef = asRef('e-continue-recovery')
  failed.stateBefore.elements.push({ ...structuredClone(failed.stateBefore.elements[0]!), ref: secondRef,
    name: 'Recovery', nameNormalized: 'recovery', labels: { ariaLabel: 'Recovery' } })
  failed.stateBefore.refMap[secondRef] = structuredClone(failed.stateBefore.refMap[failed.stateBefore.elements[0]!.ref]!)
  const recovering = structuredClone(failed)
  recovering.plannedAction = { type: 'click', ref: secondRef }
  recovering.result = { success: true }
  recovering.callRecord = { resolvedModelId: 'small-fixture' }
  // The pair's own states differ: its weight must use the FAILED population.
  recovering.stateBefore.url = 'https://example.test/recovery'
  step.subActions = [failed, recovering]
  step.selfHeal = { failedDecision: { plan: failed.plan, plannedAction: failed.plannedAction, result: failed.result },
    recoveringDecision: { plan: recovering.plan, plannedAction: recovering.plannedAction, result: recovering.result } }
  if (rerun) {
    member.isRerun = true; member.rerunAttempt = 2
    const evidence = structuredClone(step)
    delete evidence.selfHeal
    evidence.verifierVerdict.pass = false
    const facts = { runId: f.handoff.runId, testId: member.testId, testIndex: 0, stepIndex: 0, decisionOrdinal: 0, evidence }
    const origin = { attempt: 0, outcome: 'failed' as const, decisions: [{ ...facts,
      screenStateHash: screenStateHash(evidence.subActions[0]!.stateBefore), evidenceDigest: sha256hex(canonicalJson(facts)) }] }
    member.rerunOrigin = { ...origin, evidenceDigest: sha256hex(canonicalJson(origin)) }
  }
  f.save()
  return { ...f, step, member, committedRoot: join(f.root, 'agent-qa-eval') }
}

async function seed(f: ReturnType<typeof fixture>) {
  const session = await resolveEvalSession({ configPath: f.configPath })
  const report = await runSeedVerb(session, {}, fractions)
  expect(report.runsSkipped).toEqual([])
  expect(report.refusals).toEqual([])
  const read = readCommittedCorpus(f.committedRoot)
  expect(read.refusals).toEqual([])
  const pair = [...read.snapshot.labelsById.values()].filter(row => row.label.sourceChannel === 'self-heal-pair')
  expect(pair).toHaveLength(2)
  return { session, report, read, pair }
}

describe('420 actual CLI seed weights', () => {
  it('persists the 0.45 silver/degraded vector and leaves cassette embedded labels unchanged', async () => {
    const f = fixture()
    const { pair, read } = await seed(f)
    expect(pair[0]!.weight?.value).toBeCloseTo(0.45, 14)
    expect(pair[0]!.weight).toMatchObject({ k: 1, n: 1, verdictFactor: 0.8, tierFactor: 0.75 })
    expect(pair[1]!.weight).toEqual(pair[0]!.weight)
    for (const row of pair) expect(read.snapshot.cassettesById.get(row.cassetteId)!.label.sourceChannel).toBe('recorded-verdict')
  })

  it('persists actual rerun provenance with the recovery weight and preserves identical reseed bytes', async () => {
    const f = fixture(true)
    const { pair, session, report } = await seed(f)
    expect(pair[0]!.weight?.value).toBeCloseTo(0.45, 14)
    expect(pair[0]!.provenance.rerun).toEqual({ attempt: 2, originalAttempt: 0,
      originalEvidenceDigest: f.member.rerunOrigin!.evidenceDigest })
    expect(pair[1]!.provenance.rerun).toEqual(pair[0]!.provenance.rerun)
    const before = bytes(f.committedRoot)
    const again = await runSeedVerb(session)
    expect(again).toMatchObject({ seededCount: 0, unchangedCount: 2, refusals: [], runsSkipped: [] })
    expect(again.partitions[0]!.saltDigest).toBe(report.partitions[0]!.saltDigest)
    expect(bytes(f.committedRoot)).toEqual(before)
  })

  it('reuses effective revised weights on unchanged source without touching membership or any historical bytes', async () => {
    const f = fixture()
    const { pair, session, read } = await seed(f)
    expect(pair[0]!.weight).toBeDefined()
    for (const label of pair) {
      const desired = { ...label, weight: { ...label.weight!, value: 0.3 } }
      const revision = createLabelRevision(label, desired)
      const path = join(f.committedRoot, committedLabelPath('default', label.cassetteId)).replace(/\.json$/, `--revision-${revision.revision!.id}.json`)
      writeFileSync(path, committedFileText(revision))
    }
    const before = bytes(f.committedRoot)
    const again = await runSeedVerb(session)
    expect(again.refusals).toEqual([])
    expect(again.unchangedCount).toBe(2)
    expect(bytes(f.committedRoot)).toEqual(before)
    const reread = readCommittedCorpus(f.committedRoot)
    expect(computeCorpusDigest(reread.snapshot.entries)).toBe(computeCorpusDigest(read.snapshot.entries))
    expect([...reread.snapshot.labelsById.values()].every(label => label.weight?.value === 0.3)).toBe(true)
  })

  it('joins committed source runs once, includes an extraction-skipped step, and preserves old weights as population grows', async () => {
    const f = fixture()
    const skipped = structuredClone(f.step)
    skipped.stepIndex = 1
    // No recorded exchange means no leaf cassette; the complete structured recovery remains evidence.
    delete skipped.subActions[1]!.exchanges
    f.member.steps.push(skipped)
    f.save()
    const { session, read } = await seed(f)
    const originalBytes = bytes(f.committedRoot)
    const next = fixture()
    const recovering = next.step.subActions[1]!
    recovering.plannedAction = { type: 'navigate', to: 'url', url: 'https://example.test/other' }
    next.step.selfHeal!.recoveringDecision.plannedAction = recovering.plannedAction
    next.save()
    cpSync(next.runDir, join(f.agentQaRoot, 'runs', deriveRunSlug(next.handoff.runId)), { recursive: true })
    const report = await runSeedVerb(session, { run: next.handoff.runId })
    expect(report).toMatchObject({ runsSkipped: [], refusals: [], seededCount: 2 })
    const after = readCommittedCorpus(f.committedRoot)
    const incoming = [...after.snapshot.labelsById.values()].filter(label => label.provenance.runId === next.handoff.runId)
    expect(incoming).toHaveLength(2)
    expect(incoming[0]!.weight).toMatchObject({ k: 1, n: 3 })
    expect(incoming[1]!.weight).toEqual(incoming[0]!.weight)
    expect(incoming[0]!.weight!.value).toBeCloseTo(0.3, 14)
    const population = collectSoftPopulation(loadLabelEvidence({ snapshot: after.snapshot, agentQaRoot: f.agentQaRoot, incoming: next.handoff }))
    expect(population.observations).toHaveLength(3)
    expect(incoming[0]!.weight!.evidenceDigest).toBe(population.evidenceDigest)
    expect(incoming[0]!.weight!.corpusDigest).toBe(computeCorpusDigest(after.snapshot.entries))
    const again = await runSeedVerb(session)
    expect(again).toMatchObject({ runsSkipped: [], refusals: [], seededCount: 0, unchangedCount: 4 })
    for (const [path, content] of originalBytes) expect(readFileSync(path!).toString('hex')).toBe(content)
    for (const [id, label] of read.snapshot.labelsById) expect(after.snapshot.labelsById.get(id)).toEqual(label)
  })

  it('refuses an escaped incoming handoff before admission or partition writes', async () => {
    const f = fixture(), outside = fixture()
    rmSync(join(f.runDir, 'handoff.json'))
    symlinkSync(join(outside.runDir, 'handoff.json'), join(f.runDir, 'handoff.json'))
    const session = await resolveEvalSession({ configPath: f.configPath })
    const report = await runSeedVerb(session, {}, fractions)
    expect(report.runsSkipped).toHaveLength(1)
    expect(report.runsAdmitted).toEqual([])
    expect(existsSync(f.committedRoot)).toBe(false)
  })

  it('preserves recorded masked planner evidence through both new weight blocks into the committed root', async () => {
    const f = fixture()
    writeFileSync(join(f.root, '.env.secrets.local'), 'PRIVATE_MODEL=operator-private-model-fixture-420\n')
    const session = await resolveEvalSession({ configPath: f.configPath })
    const masked = session.mask('operator-private-model-fixture-420')
    expect(masked).toBe('[secret:PRIVATE_MODEL]')
    f.step.subActions[1]!.callRecord = { resolvedModelId: masked }
    f.save()
    const report = await runSeedVerb(session, {}, fractions)
    expect(report).toMatchObject({ runsSkipped: [], refusals: [], seededCount: 2 })
    const rows = [...readCommittedCorpus(f.committedRoot).snapshot.labelsById.values()]
    expect(rows).toHaveLength(2)
    for (const label of rows) expect(label.weight?.capabilityEvidence).toEqual({ kind: 'model-identity',
      modelIdentity: { provider: 'openai', modelId: masked } })
    for (const path of files(f.committedRoot)) expect(readFileSync(path).toString()).not.toContain('operator-private-model-fixture-420')
  })
})
