import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  asEvidenceToken,
  asRecordId,
  deriveEvidenceToken,
  isPromotionReceipt,
  type CanaryOutcome,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { deriveBundleTrust, readGateReceipts } from '../../bundle-read.js'
import { acquireWriterLease } from '../../lease/writer-lease.js'
import { enqueueCanaryOutcome } from '../../queue/canary-queue.js'
import { drainQueue } from '../drain.js'
import { createLocalKnowledgeStore } from '../knowledge-store.js'
import { createPromotionFloorFixture } from './fixtures/promotion-floor-fixture.js'

describe('promotion doors share receipt authority', () => {
  let root: string
  let knowledgeRoot: string
  let fixture: ReturnType<typeof createPromotionFloorFixture>
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'promotion-doors-'))
    knowledgeRoot = join(root, 'knowledge')
    fixture = createPromotionFloorFixture({ knowledgeRoot })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  function store(onPromotionOutcome = vi.fn()) {
    const lease = acquireWriterLease(knowledgeRoot)
    const authority = lease.kind === 'acquired' ? lease : lease.kind === 'held' ? lease.holder : undefined
    if (authority === undefined) throw new Error('expected writer authority')
    return createLocalKnowledgeStore({
      knowledgeRoot, executionContext: 'local-interactive',
      epoch: authority.epoch, writerLeaseId: authority.leaseId, sourceBuildOrdinal: 46,
      onPromotionOutcome,
    })
  }

  async function confirmed() {
    const seeded = fixture.publishHeldCandidate('door')
    const port = store()
    await port.commit([{ kind: 'Confirm', origin: 'agent', scope: seeded.draft.scope,
      citedIds: [seeded.published.id], targetId: seeded.published.id,
      evidenceToken: asEvidenceToken('door-confirm'),
      authorship: { path: 'deterministic-fallback', executionContext: 'local-interactive' } }])
    return { ...seeded, port }
  }

  function positive(seeded: ReturnType<typeof fixture.publishHeldCandidate>): CanaryOutcome {
    return { candidateId: seeded.published.id, runOutcome: 'positive', benefit: 'rode-along', stateValidity: 'unknown', runId: 'door-canary',
      testId: 'checkout', testIndex: 0, stepIndex: 0, buildOrdinal: 46,
      briefDigest: 'door-brief', attribution: 'The served selector was exercised.',
      exercisedAnchor: seeded.draft.anchors[0]! }
  }

  function assertPromotionLast() {
    const { dir, bundle } = fixture.onlyBundle()
    const promoted = bundle.events.filter(event => event.type === 'promoted')
    const lines = readGateReceipts(dir, bundle.manifest.id) ?? []
    expect(promoted).toHaveLength(1)
    expect(lines.filter(isPromotionReceipt)).toHaveLength(1)
    const last = lines.at(-1)!
    expect(isPromotionReceipt(last)).toBe(true)
    expect(promoted[0]!.buildOrdinal).toBeLessThanOrEqual(last.producedAtOrdinal)
    expect(JSON.parse(readFileSync(join(dir, 'evidence/gates.jsonl'), 'utf8').trim().split('\n').at(-1)!)).toEqual(last)
    expect(deriveBundleTrust(bundle).status).toBe('active')
    return last
  }

  it('door 2 commits the Confirm and promotes via the floor', async () => {
    const seeded = fixture.publishHeldCandidate('canary')
    const reports = vi.fn()
    await expect(store(reports).recordCanaryOutcome(positive(seeded))).resolves.toBeUndefined()
    expect(reports).toHaveBeenCalledExactlyOnceWith({ candidateId: seeded.published.id, promotionPath: 'deterministic-verdict-floor' })
    expect(fixture.onlyBundle().bundle.events.filter(event => event.type === 'confirmed')).toHaveLength(1)
    expect(assertPromotionLast()).toMatchObject({ promotionPath: 'deterministic-verdict-floor' })
  })

  it('queued door 2 promotes via the floor without calling an author', async () => {
    const seeded = fixture.publishHeldCandidate('queued-canary')
    expect(enqueueCanaryOutcome(knowledgeRoot, positive(seeded)).kind).toBe('enqueued')
    const author = vi.fn(async () => { throw new Error('canary must not call an author') })
    const report = await drainQueue({ knowledgeRoot, executionContext: 'local-interactive', author, maintenance: 'skip' })
    expect(report).toMatchObject({ jobsProcessed: 1, failures: 0 })
    expect(report.promotions).toEqual([{ candidateId: seeded.published.id, promotionPath: 'deterministic-verdict-floor' }])
    expect(author).not.toHaveBeenCalled()
    assertPromotionLast()
  })

  it('door 3 promotes via the floor and records the job identity', async () => {
    const { candidateId, report } = await fixture.drainWithoutModel(fixture.selectorProjection('floor'))
    expect(report.promotions).toEqual([{ candidateId, promotionPath: 'deterministic-verdict-floor' }])
    expect(assertPromotionLast()).toMatchObject({ promotionPath: 'deterministic-verdict-floor', producedBy: { jobId: candidateId } })
  })

  it('re-drain preserves one active transition, one event and one promotion line', async () => {
    const seededProjection = fixture.selectorProjection('redrain')
    const projection = { ...seededProjection, evidenceToken: deriveEvidenceToken({
      attributingObservationId: seededProjection.attributingObservationId,
      anchor: seededProjection.anchors[0]!,
      buildOrdinal: seededProjection.buildOrdinal,
    }) }
    await fixture.drainWithoutModel(projection)
    const first = fixture.onlyBundle()
    const trust = deriveBundleTrust(first.bundle)
    const bytes = readFileSync(join(first.dir, 'evidence/outcomes.jsonl'), 'utf8')
    const { report } = await fixture.drainWithoutModel(projection)
    expect(report.noops).toBe(1)
    expect(report.promotions?.some(outcome => outcome.promotionPath !== undefined)).toBe(false)
    expect(report.promotions).toEqual([])
    expect(readFileSync(join(first.dir, 'evidence/outcomes.jsonl'), 'utf8')).toBe(bytes)
    expect(deriveBundleTrust(fixture.onlyBundle().bundle)).toEqual(trust)
    assertPromotionLast()
  })

  it('drain then explicit door 1 promotion returns already-active with one path', async () => {
    await fixture.drainWithoutModel(fixture.selectorProjection('two-doors'))
    const first = fixture.onlyBundle()
    const trust = deriveBundleTrust(first.bundle)
    await expect(store().promote(asRecordId(first.bundle.manifest.id))).resolves.toEqual({ kind: 'already-active', promotionPath: 'deterministic-verdict-floor' })
    expect(deriveBundleTrust(fixture.onlyBundle().bundle)).toEqual(trust)
    assertPromotionLast()
  })

  it('door 1 appends the promotion line last after its promoted event', async () => {
    const { port, published } = await confirmed()
    await port.promote(published.id)
    assertPromotionLast()
  })
})
