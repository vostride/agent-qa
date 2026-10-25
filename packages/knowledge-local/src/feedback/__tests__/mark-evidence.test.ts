import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION, asEvidenceToken, asRecordId, asRunId, foldBundleTrust,
  type BundleOutcomeEvent, type CompletedRunHandoff } from '@vostride/agent-qa-schema'
import { publishBundle } from '../../bundle-publish.test-helper.js'
import { appendOutcomeEvent } from '../../bundle-append.js'
import { deriveBundleTrust, loadBundle, verifyBundleIntegrity } from '../../bundle-read.js'
import { acquireWriterLease, releaseLease } from '../../lease/writer-lease.js'
import { makeBundleDraftFixture, scaffoldKnowledgeRoot } from '../../__tests__/fixtures/bundle-fixture.js'
import { canaryOutcomeObservationId } from '../../serving/canary-observation-id.js'
import { createLocalKnowledgeStore } from '../../curator/knowledge-store.js'
import { appendMarkEvidence, type AppendMarkEvidenceInput } from '../mark-evidence.js'

describe('mark evidence appends through the production writer', () => {
  let root: string
  let knowledgeRoot: string
  const runId = asRunId('marked-run')
  const scope = { tier: 'product', key: 'storefront' } as const
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mark-evidence-'))
    knowledgeRoot = join(root, 'knowledge')
    scaffoldKnowledgeRoot(knowledgeRoot)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function plant(name: string, source?: { runId: string; curationJobId: string }) {
    const result = publishBundle({ knowledgeRoot, productKey: 'storefront', commitArtifacts: 'none' }, {
      draft: makeBundleDraftFixture({ scope, summary: name }),
      discriminant: { kind: 'fact', subtype: 'selector', elementRef: { role: 'button', name } },
      originClass: 'agent-verified', createdAtOrdinal: 10, screenStates: [], initialEvents: [],
      relations: [], provenance: { mode: 'run-linked', runId: 'seed-run', testId: 'seed-test', stepIndex: 0,
        ...source }, artifacts: [],
    })
    if (result.kind !== 'published') throw new Error('fixture must publish')
    return result
  }
  function input(ids: string[], kind: AppendMarkEvidenceInput['mark']['kind'] = 'false-fail'): AppendMarkEvidenceInput {
    const lease = acquireWriterLease(knowledgeRoot)
    if (lease.kind !== 'acquired') throw new Error('fixture must hold writer authority')
    return { knowledgeRoot, executionContext: 'local-interactive',
      lease: { leaseId: lease.leaseId, epoch: lease.epoch },
      mark: { markId: 'mark_0123456789ab', runId, kind }, servedRecordIds: ids }
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
  function observation(recordId: string, overrides: Partial<Parameters<typeof canaryOutcomeObservationId>[0]> = {}) {
    return canaryOutcomeObservationId({ candidateId: asRecordId(recordId), runId,
      testId: 'checkout', testIndex: 0, stepIndex: 0, ...overrides })
  }
  function append(recordId: string, value: AppendMarkEvidenceInput, event: BundleOutcomeEvent) {
    const result = appendOutcomeEvent({ knowledgeRoot, productKey: 'storefront',
      commitArtifacts: 'none', writerLeaseId: value.lease.leaseId, writerEpoch: value.lease.epoch },
    asRecordId(recordId), event)
    expect(result.kind).toBe('appended')
  }
  function loaded(dir: string) {
    const outcome = loadBundle(dir)
    if (outcome.kind !== 'loaded') throw new Error(`bundle must load: ${outcome.kind}`)
    return outcome.bundle
  }
  function helpful(recordId: string, overrides: Partial<Extract<BundleOutcomeEvent,
    { type: 'helpful' | 'confirmed' }>> = {}): BundleOutcomeEvent {
    return { type: 'helpful', evidenceToken: asEvidenceToken('original-evidence'),
      curationJobId: 'canary-job', buildOrdinal: 12, observationId: observation(recordId), ...overrides }
  }

  it.each(['false-fail', 'confirmed-bug'] as const)('%s confirms two served records once with verified hashes', async (kind) => {
    const a = plant('Checkout'); const b = plant('Cart')
    const value = input([a.id, b.id, a.id], kind)
    expect(await appendMarkEvidence(value)).toEqual({ confirmed: 2, overturned: 0, skipped: [] })
    for (const row of [a, b]) {
      expect(loaded(row.dir).events).toMatchObject([{ type: 'confirmed', origin: 'user',
        evidenceToken: `mark:${value.mark.markId}`, curationJobId: `mark:${value.mark.markId}` }])
      expect(verifyBundleIntegrity(row.dir)).toEqual({ ok: true, violations: [] })
    }
    const before = readFileSync(join(a.dir, 'evidence/outcomes.jsonl'), 'utf8')
    expect(await appendMarkEvidence(value)).toEqual({ confirmed: 0, overturned: 0, skipped: [
      { recordId: a.id, reason: 'already-appended' }, { recordId: b.id, reason: 'already-appended' },
    ] })
    expect(readFileSync(join(a.dir, 'evidence/outcomes.jsonl'), 'utf8')).toBe(before)
  })

  it('false-pass compensates exact evidence identities without changing original bytes or status', async () => {
    const a = plant('Checkout')
    const value = input([a.id], 'false-pass'); value.handoff = handoff()
    append(a.id, value, helpful(a.id))
    append(a.id, value, helpful(a.id, { type: 'confirmed', curationJobId: 'second-job' }))
    const before = readFileSync(join(a.dir, 'evidence/outcomes.jsonl'), 'utf8')
    const status = deriveBundleTrust(loaded(a.dir)).status
    expect(await appendMarkEvidence(value)).toEqual({ confirmed: 1, overturned: 2, skipped: [] })
    expect(readFileSync(join(a.dir, 'evidence/outcomes.jsonl'), 'utf8').startsWith(before)).toBe(true)
    const bundle = loaded(a.dir)
    expect(bundle.events.filter((event) => event.type === 'overturned')).toMatchObject([
      { overturnsEvidenceToken: 'original-evidence', overturnsCurationJobId: 'canary-job' },
      { overturnsEvidenceToken: 'original-evidence', overturnsCurationJobId: 'second-job' },
    ])
    const folded = foldBundleTrust(bundle.events, { originClass: bundle.provenance.originClass,
      evidenceIncomplete: false, createdAtOrdinal: 10 })
    expect(folded.counters).toMatchObject({ confirmed: 1, helpful: 0 }) // only the new mark survives
    expect(folded.status).toBe(status)
    expect(verifyBundleIntegrity(a.dir).ok).toBe(true)
    expect(await appendMarkEvidence(value)).toEqual({ confirmed: 0, overturned: 0,
      skipped: [{ recordId: a.id, reason: 'already-appended' }] })
  })

  it('does not correlate the wrong run, member, step or candidate and discloses missing correlation', async () => {
    const a = plant('Checkout')
    const value = input([a.id], 'false-pass')
    const coordinates = [{ runId: 'different-run' }, { testId: 'different-member' },
      { testIndex: 1 }, { stepIndex: 1 }, { candidateId: asRecordId('different-candidate') }]
    for (const [index, coordinate] of coordinates.entries()) {
      append(a.id, value, helpful(a.id, { evidenceToken: asEvidenceToken(`foreign-${index}`),
        observationId: observation(a.id, coordinate) }))
    }
    append(a.id, value, helpful(a.id))
    expect(await appendMarkEvidence(value)).toMatchObject({ confirmed: 1, overturned: 0, correlationIncomplete: true })
    value.handoff = handoff()
    expect(await appendMarkEvidence(value)).toEqual({ confirmed: 0, overturned: 1, skipped: [] })
    expect(deriveBundleTrust(loaded(a.dir)).counters.helpful).toBe(5)
    value.handoff.runId = asRunId('wrong-run')
    const before = readFileSync(join(a.dir, 'evidence/outcomes.jsonl'), 'utf8')
    await expect(appendMarkEvidence(value)).rejects.toThrow('another run')
    expect(readFileSync(join(a.dir, 'evidence/outcomes.jsonl'), 'utf8')).toBe(before)
  })

  it('correlates deterministic floor evidence by an explicitly supplied curation job', async () => {
    const a = plant('Checkout')
    const value = input([a.id], 'false-pass'); value.handoff = handoff(); value.curationJobIds = ['floor-job']
    append(a.id, value, { type: 'confirmed', evidenceToken: asEvidenceToken('floor-evidence'),
      curationJobId: 'floor-job', buildOrdinal: 12 })
    append(a.id, value, { type: 'promoted', evidenceToken: asEvidenceToken('floor-promotion'),
      curationJobId: 'floor-job', buildOrdinal: 12 })
    expect(await appendMarkEvidence(value)).toEqual({ confirmed: 1, overturned: 1, skipped: [] })
    expect(deriveBundleTrust(loaded(a.dir)).status).toBe('active')
  })
  it('overturns unserved run/job/provenance positives with zero served IDs, preserving unrelated evidence and status', async () => {
    const linked = plant('Newly curated', { runId, curationJobId: 'seed-job' })
    const unrelated = plant('Unrelated')
    const value = input([], 'false-pass'); value.handoff = handoff(); value.curationJobIds = ['floor-job']
    append(linked.id, value, helpful(linked.id, { curationJobId: 'seed-job', observationId: undefined }))
    append(linked.id, value, helpful(linked.id, { curationJobId: 'floor-job', evidenceToken: asEvidenceToken('floor'), observationId: undefined }))
    append(unrelated.id, value, helpful(unrelated.id, { observationId: 'another-run' }))
    const before = readFileSync(join(unrelated.dir, 'evidence/outcomes.jsonl'))
    const status = deriveBundleTrust(loaded(linked.dir)).status
    expect(await appendMarkEvidence(value)).toMatchObject({ confirmed: 0, overturned: 2 })
    expect(loaded(linked.dir).events.filter(event => event.type === 'confirmed')).toEqual([])
    expect(deriveBundleTrust(loaded(linked.dir))).toMatchObject({ status, counters: { helpful: 0 } })
    expect(readFileSync(join(unrelated.dir, 'evidence/outcomes.jsonl'))).toEqual(before)
  })

  it('overturns a real positive canary Confirm emitted through the knowledge-port bridge', async () => {
    const a = plant('Checkout'); const value = input([a.id], 'false-pass'); value.handoff = handoff()
    const port = createLocalKnowledgeStore({ knowledgeRoot,
      executionContext: 'local-interactive', writerLeaseId: value.lease.leaseId, epoch: value.lease.epoch,
      sourceBuildOrdinal: 12, sourceRunId: runId })
    await port.recordCanaryOutcome({ candidateId: a.id, runId, testId: 'checkout', testIndex: 0,
      stepIndex: 0, buildOrdinal: 12, runOutcome: 'positive', benefit: 'rode-along',
      exercisedAnchor: loaded(a.dir).frontmatter.anchors[0]!.raw,
      briefDigest: 'brief', attribution: 'recorded test outcome' })
    const before = loaded(a.dir)
    expect(before.events.filter((event) => event.type === 'confirmed')).toHaveLength(1)
    expect(before.events.find((event) => event.type === 'confirmed')?.observationId).toMatch(/^knowledge-port:/)
    const status = deriveBundleTrust(before).status
    expect(await appendMarkEvidence(value)).toEqual({ confirmed: 1, overturned: 1, skipped: [] })
    expect(deriveBundleTrust(loaded(a.dir)).counters.confirmed).toBe(1)
    expect(deriveBundleTrust(loaded(a.dir)).status).toBe(status)
  })

  it('recognizes the emitter floor observation address with exact member and step boundaries', async () => {
    const a = plant('Checkout'); const value = input([a.id], 'false-pass'); value.handoff = handoff()
    for (const stepIndex of [0, 10]) {
      append(a.id, value, { type: 'confirmed', evidenceToken: asEvidenceToken(`floor-step-${stepIndex}`),
        curationJobId: 'opaque-floor-job', buildOrdinal: 12,
        observationId: `${runId}:test-0:step-${stepIndex}` })
    }
    expect(await appendMarkEvidence(value)).toEqual({ confirmed: 1, overturned: 1, skipped: [] })
    expect(deriveBundleTrust(loaded(a.dir)).counters.confirmed).toBe(2)
  })

  it('skips an unreadable bundle while confirming the readable one', async () => {
    const a = plant('Checkout'); const b = plant('Cart')
    writeFileSync(join(a.dir, 'manifest.json'), 'unreadable', 'utf8')
    const value = input([a.id, b.id])
    expect(await appendMarkEvidence(value)).toEqual({ confirmed: 1, overturned: 0,
      skipped: [{ recordId: a.id, reason: 'bundle-unreadable' }] })
    expect(loaded(b.dir).events).toHaveLength(1)
  })

  it('uses run-linked provenance for floor evidence without assuming every line is from the seed run', async () => {
    const a = plant('Checkout', { runId, curationJobId: 'seed-job' })
    const value = input([a.id], 'false-pass')
    for (const job of ['seed-job', 'foreign-job']) {
      append(a.id, value, { type: 'confirmed', evidenceToken: asEvidenceToken(`floor-${job}`),
        curationJobId: job, buildOrdinal: 12 })
    }
    expect(await appendMarkEvidence(value)).toMatchObject({ confirmed: 1, overturned: 1, correlationIncomplete: true })
    expect(deriveBundleTrust(loaded(a.dir)).counters.confirmed).toBe(2)
  })

  it('refuses a released writer lease before appending', async () => {
    const a = plant('Checkout'); const value = input([a.id])
    expect(releaseLease({ knowledgeRoot, leaseId: value.lease.leaseId }).kind).toBe('released')
    await expect(appendMarkEvidence(value)).rejects.toThrow()
    expect(loaded(a.dir).events).toEqual([])
  })
})
