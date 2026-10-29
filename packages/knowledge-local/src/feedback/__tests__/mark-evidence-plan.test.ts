import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION, asEvidenceToken, asRecordId, asRunId, type BundleOutcomeEvent,
  type CompletedRunHandoff } from '@vostride/agent-qa-schema'
import { publishBundle } from '../../bundle-publish.test-helper.js'
import { appendOutcomeEvent } from '../../bundle-append.js'
import { loadBundle } from '../../bundle-read.js'
import { acquireWriterLease, releaseLease } from '../../lease/writer-lease.js'
import { makeBundleDraftFixture, scaffoldKnowledgeRoot } from '../../__tests__/fixtures/bundle-fixture.js'
import { canaryOutcomeObservationId } from '../../serving/canary-observation-id.js'
import * as readerEntry from '../../reader.js'
import { appendMarkEvidence, type AppendMarkEvidenceInput, type AppendMarkEvidenceOutcome } from '../mark-evidence.js'

function planner() {
  // Select the actual /reader entry exports so the planning half is proven reachable without the writer.
  expect(typeof readerEntry.planMarkEvidence, 'the /reader entry must export planMarkEvidence').toBe('function')
  expect(typeof readerEntry.projectMarkEvidenceOutcome, 'the /reader entry must export projectMarkEvidenceOutcome')
    .toBe('function')
  return readerEntry
}

function treeBytes(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name)
      const key = relative(dir, path)
      if (statSync(path).isDirectory()) { out.set(`${key}/`, ''); walk(path) }
      else out.set(key, readFileSync(path).toString('base64'))
    }
  }
  walk(dir)
  return out
}

describe('mark evidence planning half', () => {
  let root: string
  let knowledgeRoot: string
  const runId = asRunId('marked-run')
  const markId = 'mark_0123456789ab'
  const scope = { tier: 'product', key: 'storefront' } as const
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mark-evidence-plan-'))
    knowledgeRoot = join(root, 'knowledge')
    scaffoldKnowledgeRoot(knowledgeRoot)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function plant(name: string, source?: { runId: string; curationJobId: string }) {
    const result = publishBundle({ knowledgeRoot, productKey: 'storefront' }, {
      draft: makeBundleDraftFixture({ scope, summary: name }),
      discriminant: { kind: 'fact', subtype: 'selector', elementRef: { role: 'button', name } },
      originClass: 'agent-verified', createdAtOrdinal: 10, screenStates: [], initialEvents: [],
      relations: [], provenance: { mode: 'run-linked', runId: 'seed-run', testId: 'seed-test', stepIndex: 0,
        ...source }, artifacts: [],
    })
    if (result.kind !== 'published') throw new Error('fixture must publish')
    return result
  }
  function lease() {
    const acquired = acquireWriterLease(knowledgeRoot)
    if (acquired.kind !== 'acquired') throw new Error('fixture must hold writer authority')
    return { leaseId: acquired.leaseId, epoch: acquired.epoch }
  }
  function handoff(): CompletedRunHandoff {
    return { schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION, runId, scope, buildOrdinal: 12, executionContext: 'local-interactive',
      aggregateVerdict: 'passed', configDigests: { suiteConfigDigest: '', testConfigDigest: '' },
      startedAt: 0, endedAt: 1, tests: [{ testId: 'checkout', testIndex: 0,
        testName: 'Checkout', filePath: 'test.yaml', outcome: 'passed', steps: [{ stepIndex: 0,
          stepText: 'Checkout', cacheStatus: 'miss', servedBrief: { scope, asOfBuild: 12, budget: 200,
            truncation: '', channel1: [], channel2: [], channel3: [], briefDigest: 'brief' },
          subActions: [], verifierVerdict: { pass: true, reasoning: 'Done' } }] }] }
  }
  function append(recordId: string, held: { leaseId: string; epoch: number }, event: BundleOutcomeEvent) {
    const result = appendOutcomeEvent({ knowledgeRoot, productKey: 'storefront',
      writerLeaseId: held.leaseId, writerEpoch: held.epoch }, asRecordId(recordId), event)
    expect(result.kind).toBe('appended')
  }
  function helpful(recordId: string, overrides: Partial<Extract<BundleOutcomeEvent,
    { type: 'helpful' | 'confirmed' }>> = {}): BundleOutcomeEvent {
    return { type: 'helpful', evidenceToken: asEvidenceToken('original-evidence'), curationJobId: 'canary-job',
      buildOrdinal: 12, observationId: canaryOutcomeObservationId({ candidateId: asRecordId(recordId), runId,
        testId: 'checkout', testIndex: 0, stepIndex: 0 }), ...overrides }
  }
  function markEvents(dir: string) {
    const loaded = loadBundle(dir)
    if (loaded.kind !== 'loaded') throw new Error('bundle must load')
    return loaded.bundle.events.filter(event => event.curationJobId === `mark:${markId}`)
  }

  it('CORRELATED-EVIDENCE: plans overturns on correlated unserved records without a markId, lease or write', async () => {
    const api = planner()
    const held = lease()
    const linked = plant('Newly curated', { runId, curationJobId: 'seed-job' })
    const observed = plant('Canary observed')
    const jobbed = plant('Floor job')
    const unrelated = plant('Unrelated')
    append(linked.id, held, helpful(linked.id, { curationJobId: 'seed-job', observationId: undefined }))
    append(observed.id, held, helpful(observed.id))
    append(jobbed.id, held, { type: 'confirmed', evidenceToken: asEvidenceToken('floor'), curationJobId: 'floor-job',
      buildOrdinal: 12 })
    append(unrelated.id, held, helpful(unrelated.id, { observationId: 'another-run' }))
    expect(releaseLease({ knowledgeRoot, leaseId: held.leaseId }).kind).toBe('released')

    const planInput = { knowledgeRoot, mark: { runId, kind: 'false-pass' as const }, servedRecordIds: [],
      handoff: handoff(), curationJobIds: ['floor-job'] }
    const before = treeBytes(root)
    const plan = api.planMarkEvidence(planInput)
    expect(treeBytes(root)).toEqual(before)
    const byId = new Map(plan.targets.map(target => [target.recordId, target]))
    expect(byId.has(unrelated.id)).toBe(false)
    expect(byId.get(linked.id)).toMatchObject({ kind: 'effects', served: false, effects: [
      { direction: 'overturn', overturnsEvidenceToken: 'original-evidence', overturnsCurationJobId: 'seed-job' }] })
    expect(byId.get(observed.id)).toMatchObject({ kind: 'effects', served: false, effects: [
      { direction: 'overturn', overturnsEvidenceToken: 'original-evidence', overturnsCurationJobId: 'canary-job' }] })
    expect(byId.get(jobbed.id)).toMatchObject({ kind: 'effects', effects: [
      { direction: 'overturn', overturnsEvidenceToken: 'floor', overturnsCurationJobId: 'floor-job' }] })
    expect(plan.correlationIncomplete).toBeUndefined()

    const predicted = api.projectMarkEvidenceOutcome(plan, { includeAlreadyAppended: false })
    expect(predicted).toMatchObject({ confirmed: 0, overturned: 3, skipped: [] })
    const writerInput: AppendMarkEvidenceInput = { ...planInput, executionContext: 'local-interactive',
      lease: lease(), mark: { markId, runId, kind: 'false-pass' } }
    expect(await appendMarkEvidence(writerInput)).toEqual(predicted)
    for (const target of plan.targets) {
      if (target.kind !== 'effects') continue
      const dir = [linked, observed, jobbed].find(row => row.id === target.recordId)!.dir
      expect(markEvents(dir).map(event => event.type === 'overturned'
        ? { direction: 'overturn', overturnsEvidenceToken: event.overturnsEvidenceToken,
          overturnsCurationJobId: event.overturnsCurationJobId } : { direction: 'confirm' }))
        .toEqual(target.effects.map(({ alreadyAppended: _, ...effect }) => effect))
      expect(markEvents(dir).every(event => event.buildOrdinal === target.buildOrdinal)).toBe(true)
    }
  })

  it('SERVED-BOTH-DIRECTIONS: one served record receives both confirm and overturn effects', async () => {
    const api = planner()
    const a = plant('Checkout')
    const held = lease()
    append(a.id, held, helpful(a.id))
    append(a.id, held, helpful(a.id, { type: 'confirmed', curationJobId: 'second-job' }))
    const planInput = { knowledgeRoot, mark: { runId, kind: 'false-pass' as const }, servedRecordIds: [a.id],
      handoff: handoff() }
    const plan = api.planMarkEvidence(planInput)
    expect(plan.targets).toEqual([{ recordId: a.id, kind: 'effects', productKey: 'storefront', served: true,
      buildOrdinal: 13, effects: [
        { direction: 'confirm', alreadyAppended: false },
        { direction: 'overturn', overturnsEvidenceToken: 'original-evidence', overturnsCurationJobId: 'canary-job',
          alreadyAppended: false },
        { direction: 'overturn', overturnsEvidenceToken: 'original-evidence', overturnsCurationJobId: 'second-job',
          alreadyAppended: false },
      ] }])
    const predicted = api.projectMarkEvidenceOutcome(plan, { includeAlreadyAppended: false })
    expect(predicted).toEqual({ confirmed: 1, overturned: 2, skipped: [] })
    expect(await appendMarkEvidence({ ...planInput, executionContext: 'local-interactive',
      lease: held, mark: { markId, runId, kind: 'false-pass' } })).toEqual(predicted)
    expect(markEvents(a.dir).map(event => event.type)).toEqual(['confirmed', 'overturned', 'overturned'])

    for (const kind of ['false-fail', 'confirmed-bug'] as const) {
      const confirmOnly = api.planMarkEvidence({ ...planInput, mark: { runId, kind } })
      expect(confirmOnly.targets).toMatchObject([{ recordId: a.id, served: true,
        effects: [{ direction: 'confirm', alreadyAppended: false }] }])
    }
  })

  it('EVIDENCE-UNREADABLE: unreadable and unresolved targets keep their order and the missing-correlation arm', async () => {
    const api = planner()
    const a = plant('Checkout'); const b = plant('Cart')
    writeFileSync(join(a.dir, 'manifest.json'), 'unreadable', 'utf8')
    const planInput = { knowledgeRoot, mark: { runId, kind: 'false-fail' as const },
      servedRecordIds: [a.id, 'missing-record', b.id] }
    const plan = api.planMarkEvidence(planInput)
    expect(plan.targets).toEqual([
      { recordId: a.id, kind: 'unreadable' },
      { recordId: 'missing-record', kind: 'unreadable' },
      { recordId: b.id, kind: 'effects', productKey: 'storefront', served: true, buildOrdinal: 11,
        effects: [{ direction: 'confirm', alreadyAppended: false }] },
    ])
    const predicted = api.projectMarkEvidenceOutcome(plan, { includeAlreadyAppended: false })
    expect(predicted).toEqual({ confirmed: 1, overturned: 0, skipped: [
      { recordId: a.id, reason: 'bundle-unreadable' }, { recordId: 'missing-record', reason: 'bundle-unreadable' }] })
    expect(await appendMarkEvidence({ ...planInput, executionContext: 'local-interactive',
      lease: lease(), mark: { markId, runId, kind: 'false-fail' } })).toEqual(predicted)

    const incomplete = api.planMarkEvidence({ knowledgeRoot, mark: { runId, kind: 'false-pass' }, servedRecordIds: [b.id] })
    expect(incomplete.correlationIncomplete).toBe(true)
    expect(api.projectMarkEvidenceOutcome(incomplete, { includeAlreadyAppended: false }))
      .toMatchObject({ correlationIncomplete: true })
    expect(() => api.planMarkEvidence({ knowledgeRoot, mark: { runId: asRunId('other-run'), kind: 'false-pass' },
      servedRecordIds: [], handoff: handoff() })).toThrow('another run')
  })

  it('EVIDENCE-DEDUP: repeated ids plan once and a resumed mark plans its durable effects as already appended', async () => {
    const api = planner()
    const a = plant('Checkout'); const b = plant('Cart')
    const held = lease()
    append(a.id, held, helpful(a.id))
    const planInput = { knowledgeRoot, mark: { runId, kind: 'false-pass' as const }, servedRecordIds: [a.id, b.id, a.id],
      handoff: handoff() }
    const fresh = api.planMarkEvidence(planInput)
    expect(fresh.targets.map(target => target.recordId)).toEqual([a.id, b.id])
    const writerInput: AppendMarkEvidenceInput = { ...planInput, executionContext: 'local-interactive',
      lease: held, mark: { markId, runId, kind: 'false-pass' } }
    expect(await appendMarkEvidence(writerInput)).toEqual(api.projectMarkEvidenceOutcome(fresh, {
      includeAlreadyAppended: false }))

    const before = treeBytes(root)
    const resumed = api.planMarkEvidence({ ...planInput, mark: { runId, kind: 'false-pass', markId } })
    expect(treeBytes(root)).toEqual(before)
    expect(resumed.targets.flatMap(target => target.kind === 'effects' ? target.effects : [])
      .every(effect => effect.alreadyAppended)).toBe(true)
    const unseenMark = api.planMarkEvidence({ ...planInput, mark: { runId, kind: 'false-pass', markId: 'mark_ffffffffffff' } })
    expect(unseenMark.targets.flatMap(target => target.kind === 'effects' ? target.effects : [])
      .some(effect => effect.alreadyAppended)).toBe(false)

    const skipped = api.projectMarkEvidenceOutcome(resumed, { includeAlreadyAppended: false })
    expect(skipped).toEqual({ confirmed: 0, overturned: 0, skipped: [
      { recordId: a.id, reason: 'already-appended' }, { recordId: b.id, reason: 'already-appended' }] })
    expect(await appendMarkEvidence(writerInput)).toEqual(skipped)
    const complete = api.projectMarkEvidenceOutcome(resumed, { includeAlreadyAppended: true })
    expect(complete).toEqual({ confirmed: 2, overturned: 1, skipped: [] })
    expect(await appendMarkEvidence({ ...writerInput, includeAlreadyAppended: true })).toEqual(complete)
  })
})
