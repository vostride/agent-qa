import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assignSplit, computeCorpusDigest } from '@vostride/agent-qa-eval'
import { asRunId, computeBriefDigest, distilledScreenStateDigest, slugBranch, type Benefit, type CompletedRunHandoff } from '@vostride/agent-qa-schema'
import { readCommittedCorpusDigest } from '../index.js'
import { buildRootMarkerValue } from '../committed-root-store.js'
import { writeGate1Fixture } from './fixtures/gate1-fixtures.js'
import { writeStagedFeedback } from './fixtures/staged-feedback-fixture.js'
import { listStagedFeedback, admitStagedFeedback } from '../gate2-composition.js'
import * as seeding from '../seeding-composition.js'
import { committedCorpusPath, committedLabelPath } from '../committed-root-store.js'

const NO_DECLARED_SECRETS = (text: string) => text
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function feedbackInput(f: ReturnType<typeof fixture>, route = 'novel') {
  f.step.subActions[0]!.stateBefore.url = `https://feedback.example/${route}`
  f.step.subActions[0]!.stateBefore.timestamp = 1_725_000_000
  f.save()
  return { agentQaRoot: f.agentQaRoot, committedRoot: f.committedRoot,
    product: f.handoff.scope.key, target: { runId: String(f.handoff.runId), testId: f.handoff.tests[0]!.testId, stepIndex: 0 },
    attributedObservationId: 'fixture-feedback-observation', benefit: 'rode-along' as const,
    candidateId: f.line.id, stateDigest: distilledScreenStateDigest(f.step.subActions[0]!.stateBefore),
    mask: NO_DECLARED_SECRETS }
}
function admissionInput(f: ReturnType<typeof fixture>, dryRun = false) {
  return { agentQaRoot: f.agentQaRoot, committedRoot: f.committedRoot, dryRun, mask: NO_DECLARED_SECRETS }
}
function stageFeedback(f: ReturnType<typeof fixture>, input: Omit<ReturnType<typeof feedbackInput>, 'benefit'> & { benefit: Benefit }) {
  writeStagedFeedback({ ...input, agentQaRoot: f.agentQaRoot })
}

describe('staged feedback admission', () => {
  it('admits a mixed-product and mixed-run batch once with real provenance, natural splits and unchanged labels', async () => {
    const f = fixture()
    stageFeedback(f, feedbackInput(f, 'one'))
    f.handoff.runId = asRunId(`${f.handoff.runId}-second`)
    f.handoff.buildOrdinal += 1
    f.handoff.scope = { tier: 'product', key: 'second/product' }
    f.handoff.aggregateVerdict = 'failed'
    f.handoff.tests[0]!.outcome = 'failed'
    f.step.verifierVerdict = { pass: false, reasoning: 'fixture failed live step' }
    const runDir = join(f.agentQaRoot, 'runs', slugBranch(f.handoff.runId))
    mkdirSync(runDir, { recursive: true })
    const second = feedbackInput(f, 'two')
    writeFileSync(join(runDir, 'handoff.json'), JSON.stringify(f.handoff))
    stageFeedback(f, { ...second, benefit: 'exercised-harmed' })
    const entries = listStagedFeedback({ agentQaRoot: f.agentQaRoot })
    const heldOut = assignSplit({ cassetteId: entries[0]!.extracted.cassette.id, saltHex: '0'.repeat(64), heldOutFraction: 0.999999, privateFraction: 0.999999, isPairMember: false })
    expect(heldOut.split).toBe('held-out')
    const runtime = tree(f.agentQaRoot), committed = tree(f.committedRoot)
    const dry = await admitStagedFeedback(admissionInput(f, true))
    expect(dry.entries).toHaveLength(2)
    expect(dry.admitted).toHaveLength(0)
    expect(dry).not.toHaveProperty('nextCorpusDigest')
    expect(tree(f.agentQaRoot)).toEqual(runtime)
    expect(tree(f.committedRoot)).toEqual(committed)
    const seed = vi.spyOn(seeding, 'seedCommittedCorpus')
    const result = await admitStagedFeedback(admissionInput(f))
    expect(seed).toHaveBeenCalledTimes(1)
    expect(result.refusals).toEqual([])
    expect(result.admitted).toHaveLength(2)
    expect(result.nextCorpusDigest).not.toBe(result.previousCorpusDigest)
    for (const entry of result.admitted) {
      const corpusEntry = JSON.parse(readFileSync(join(f.committedRoot, committedCorpusPath(entry.product, entry.extracted.cassette.id)), 'utf8'))
      expect(corpusEntry).toMatchObject({ split: 'natural', product: entry.product, source: 'canary-feedback',
        attributedObservationId: entry.attributedObservationId, benefit: entry.benefit,
        run_links: { runId: entry.runId, runSlug: slugBranch(entry.runId) }, captured_at_ordinal: entry.extracted.cassette.receipt.buildOrdinal })
      expect(Number.isInteger(corpusEntry.captured_at_ordinal)).toBe(true)
      expect(corpusEntry.run_links.runId).not.toBe('')
      const label = JSON.parse(readFileSync(join(f.committedRoot, committedLabelPath(entry.product, entry.extracted.cassette.id)), 'utf8'))
      expect(label.label).toEqual(entry.extracted.cassette.label)
      expect(label.label.tier).toBe('silver')
      expect(label.label.verdict.pass).toBe(entry.product !== 'second/product')
      expect(label.provenance).toMatchObject({ runId: entry.runId, capturedAtOrdinal: corpusEntry.captured_at_ordinal })
    }
    const after = tree(f.committedRoot)
    const rerun = await admitStagedFeedback(admissionInput(f))
    expect(rerun.entries).toEqual([])
    expect(rerun.nextCorpusDigest).toBe(result.nextCorpusDigest)
    expect(tree(f.committedRoot)).toEqual(after)
    expect(seed).toHaveBeenCalledTimes(1)
    seed.mockRestore()
  })
  it('retains a refused case while admitting the other case, without inferring success from aggregate counts', async () => {
    const f = fixture()
    stageFeedback(f, feedbackInput(f, 'one'))
    // Same run, new decision id and state: the stored entry remains the original immutable snapshot.
    f.step.stepIndex = 1
    const second = { ...feedbackInput(f, 'two'), target: { runId: String(f.handoff.runId), testId: f.handoff.tests[0]!.testId, stepIndex: 1 } }
    stageFeedback(f, second)
    const entries = listStagedFeedback({ agentQaRoot: f.agentQaRoot })
    const refused = entries[0]!
    const path = join(f.committedRoot, committedCorpusPath(refused.product, refused.extracted.cassette.id))
    // Plant valid conflicting corpus bytes, so the digest read itself remains valid.
    const dry = await admitStagedFeedback(admissionInput(f, true))
    expect(dry.entries).toHaveLength(2)
    const { projectCorpusEntry } = await import('@vostride/agent-qa-eval')
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify(projectCorpusEntry({ cassette: refused.extracted.cassette, product: refused.product,
      runId: refused.runId, assignment: { split: 'natural' } })))
    const result = await admitStagedFeedback(admissionInput(f))
    expect(result.admitted).toHaveLength(1)
    expect(result.refusals).toHaveLength(1)
    expect(result.refusals[0]).toMatchObject({ cassetteId: refused.extracted.cassette.id, kind: 'write-conflict' })
    expect(listStagedFeedback({ agentQaRoot: f.agentQaRoot }).map(entry => entry.dir)).toEqual([refused.dir])
  })
})

function tree(root: string) {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name)
      return [relative(root, path), readFileSync(path).toString('base64')]
    }))
}
function fixture(options: Parameters<typeof writeGate1Fixture>[1] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gate2-'))
  roots.push(root)
  const f = writeGate1Fixture(root, { targetInCorpus: false, handoffForTarget: true, proofBrief: true, ...options })
  const handoffPath = join(f.agentQaRoot, 'runs', slugBranch(f.injection.target!.runId), 'handoff.json')
  const handoff = JSON.parse(readFileSync(handoffPath, 'utf8')) as CompletedRunHandoff
  const step = handoff.tests[0]!.steps[0]!
  const line = step.servedBrief!.channel1[0]!
  line.status = 'candidate'
  line.servedAsCanary = true
  step.servedBrief!.briefDigest = computeBriefDigest(step.servedBrief!)
  const save = () => writeFileSync(handoffPath, JSON.stringify(handoff))
  save()
  return { ...f, handoff, handoffPath, step, line, save }
}
describe('committed corpus digest', () => {
  it('retains a valid initialized empty corpus digest', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate2-empty-'))
    roots.push(root)
    writeFileSync(join(root, 'eval-root.json'), JSON.stringify(buildRootMarkerValue()))
    expect(readCommittedCorpusDigest({ committedRoot: root })).toEqual({
      kind: 'digest', corpusDigest: computeCorpusDigest([]),
    })
  })
  it.each(['missing', 'malformed', 'unsupported'] as const)('refuses a %s root marker', (mode) => {
    const f = fixture()
    const marker = join(f.committedRoot, 'eval-root.json')
    if (mode === 'missing') rmSync(marker)
    else writeFileSync(marker, mode === 'malformed' ? '{' : '{"schemaVersion":999}')
    expect(readCommittedCorpusDigest({ committedRoot: f.committedRoot })).toMatchObject({ kind: 'unavailable', reason: 'corpus-unreadable' })
  })
})
