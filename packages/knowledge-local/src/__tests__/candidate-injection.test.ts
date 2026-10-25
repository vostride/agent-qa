import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asEvidenceToken, KnowledgeCandidateInjectionResultSchema } from '@vostride/agent-qa-schema'
import { renderBriefLine, renderObservationLine } from '@vostride/agent-qa-runner'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as reader from '../reader.js'
import { createPromotionFloorFixture } from '../curator/__tests__/fixtures/promotion-floor-fixture.js'
import { candidateProvenanceOf } from '../promotion-gate-input.js'
import { appendOutcomeEvent } from '../bundle-append.js'
import { deriveBundleTrust, loadBundle } from '../bundle-read.js'
import { publishBundle as publishBundleForTest } from '../bundle-publish.test-helper.js'

describe('417 candidate injection read', () => {
  let root: string
  let knowledgeRoot: string
  let fixture: ReturnType<typeof createPromotionFloorFixture>
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), '417-candidate-injection-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    fixture = createPromotionFloorFixture({ knowledgeRoot })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('reads a published candidate as rendered DATA with the promotion provenance and target', () => {
    const { published } = fixture.publishHeldCandidate('inj')
    expect(reader.candidateInjectionFor).toBeTypeOf('function')
    const result = reader.candidateInjectionFor({ knowledgeRoot, candidateId: published.id })
    expect(result.kind).toBe('found')
    if (result.kind !== 'found') throw new Error('expected candidate DATA')
    expect(result.injection).toMatchObject({
      candidateId: published.id, kind: 'fact', product: 'storefront', status: 'candidate',
      line: { tier: 'L2', servedAsCanary: false }, latestOrdinal: 42,
      target: { runId: 'held-checkout-inj-run', stepIndex: 0,
        testId: 'held-checkout-inj-test', sourceBuildOrdinal: 42 },
      provenance: { runIds: ['held-checkout-inj-run'], receiptDigests: [], capturedAtOrdinals: [42] },
    })
    expect(result.injection.renderedLine).toBe(renderObservationLine(result.injection.line))
    expect(result.injection.target).toEqual({ runId: 'held-checkout-inj-run', stepIndex: 0,
      testId: 'held-checkout-inj-test', sourceBuildOrdinal: 42 })
    const { dir, bundle } = fixture.onlyBundle()
    expect(candidateProvenanceOf(dir, bundle)).toEqual(result.injection.provenance)
    expect(KnowledgeCandidateInjectionResultSchema.parse(result)).toEqual(result)
  })

  it('renders caution candidates into L1 through the same read', () => {
    const { published } = fixture.publishHeldCaution('inj')
    expect(reader.candidateInjectionFor).toBeTypeOf('function')
    const result = reader.candidateInjectionFor({ knowledgeRoot, candidateId: published.id })
    expect(result).toMatchObject({ kind: 'found', injection: { kind: 'caution', line: { tier: 'L1' } } })
    if (result.kind !== 'found') throw new Error('expected candidate DATA')
    expect(result.injection.renderedLine).toBe(renderObservationLine(result.injection.line))
  })

  it('reports an unknown id as an ordinary not-found row', () => {
    expect(reader.candidateInjectionFor).toBeTypeOf('function')
    const result = reader.candidateInjectionFor({ knowledgeRoot, candidateId: 'missing' })
    expect(result).toEqual({ kind: 'not-found', recordId: 'missing' })
    expect(KnowledgeCandidateInjectionResultSchema.parse(result)).toEqual(result)
  })

  it('uses surviving effects for latestOrdinal and promotion provenance after a retraction', () => {
    const { published } = fixture.publishHeldCandidate('retracted')
    const config = fixture.outcomeAppendConfig()
    for (const [token, ordinal] of [['survives', 45], ['retracted', 99]] as const) {
      expect(appendOutcomeEvent(config, published.id, { type: 'confirmed',
        evidenceToken: asEvidenceToken(token), curationJobId: token,
        buildOrdinal: ordinal })).toEqual({ kind: 'appended' })
    }
    expect(appendOutcomeEvent(config, published.id, { type: 'retracted',
      evidenceToken: asEvidenceToken('rollback'), curationJobId: 'rollback', buildOrdinal: 100,
      retractsEvidenceToken: asEvidenceToken('retracted'), retractsCurationJobId: 'retracted',
      rollbackReceiptId: 'rollback' })).toEqual({ kind: 'appended' })
    const result = reader.candidateInjectionFor({ knowledgeRoot, candidateId: published.id })
    expect(result).toMatchObject({ kind: 'found', injection: {
      latestOrdinal: 45, provenance: { capturedAtOrdinals: [42, 45] },
    } })
  })

  it('omits the target for standalone knowledge and shares the learned serving projection', () => {
    const { draft } = fixture.publishHeldCandidate('template')
    const published = publishBundleForTest(fixture.outcomeAppendConfig(), {
      draft: { ...draft, summary: 'A learned candidate summary. '.repeat(10) },
      discriminant: { kind: 'fact', subtype: 'selector', elementRef: { role: 'button', name: 'Standalone' } },
      originClass: 'agent-verified', createdAtOrdinal: 9, screenStates: [], initialEvents: [],
      relations: [], provenance: { mode: 'standalone', sourceDescription: 'fixture' }, artifacts: [],
    })
    if (published.kind !== 'published') throw new Error('expected standalone bundle')
    const result = reader.candidateInjectionFor({ knowledgeRoot, candidateId: published.id })
    if (result.kind !== 'found') throw new Error('expected standalone DATA')
    expect(result.injection).not.toHaveProperty('target')
    expect(result.injection.provenance).toEqual({ runIds: [], receiptDigests: [], capturedAtOrdinals: [] })
    // Same learned serving entry and renderer, with the full summary entering once.
    const loaded = loadBundle(published.dir)
    if (loaded.kind !== 'loaded') throw new Error('expected standalone bundle read')
    const trust = deriveBundleTrust(loaded.bundle)
    const entry = { id: published.id, kind: draft.kind, title: 'standalone',
      summary: 'A learned candidate summary. '.repeat(10), trust: trust.trust,
      anchors: draft.anchors, scope: draft.scope, status: 'candidate',
      servedAsCanary: false, validity: 'current', originClass: 'agent-verified' as const }
    expect(result.injection.line).toEqual(renderBriefLine(entry).briefLine)
    expect(result.injection.line.summary).toHaveLength(140)
    expect(result.injection.renderedLine).toBe(renderObservationLine(result.injection.line))
  })
})
