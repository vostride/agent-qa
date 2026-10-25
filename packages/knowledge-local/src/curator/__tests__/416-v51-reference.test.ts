// 2026-09-06, D-06: captured BEFORE the first 416 production edit. Pins v51 outcome
// bytes, trust, status and candidate verdict across all three real promotion doors.
// Plan 06 adds assertions that gates.jsonl and its manifest key are the only new parts.
// No test-runner update path: an existing reference is NEVER rewritten.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asEvidenceToken, asRecordId, BundleOutcomeEventSchema, canonicalJson, evaluatePromotionGate,
  type BundleManifest, type CanaryOutcome, type ResolvePromotionPosture,
  type PromotionGateVerdict } from '@vostride/agent-qa-schema'
import { describe, expect, it, vi } from 'vitest'
import { appendOutcomeEvent } from '../../bundle-append.js'
import { deriveBundleTrust, readGateReceipts, verifyBundleIntegrity } from '../../bundle-read.js'
import { acquireWriterLease } from '../../lease/writer-lease.js'
import { createLocalKnowledgeStore } from '../knowledge-store.js'
import { assemblePromotionGateInput } from '../commit.js'
import { createPromotionFloorFixture, resolvedPromotionPosture } from './fixtures/promotion-floor-fixture.js'

// Observe the actual gate input at the synchronous decision boundary. The wrapper delegates
// unchanged to the real predicate; drain and canary evaluate inside their own held sections.
vi.mock('@vostride/agent-qa-schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vostride/agent-qa-schema')>()
  return { ...actual, evaluatePromotionGate: vi.fn(actual.evaluatePromotionGate) }
})
function project(verdict: PromotionGateVerdict) {
  return verdict.verdict === 'hold' ? { verdict: verdict.verdict, reason: verdict.reason }
    : { verdict: verdict.verdict }
}
const scenarios = [
  'fact/door3-drain', 'caution/door3-drain',
  'fact/door1-promote', 'caution/door1-promote',
  'fact/door2-canary', 'caution/door2-canary',
] as const
type Scenario = typeof scenarios[number]
async function capture(scenario: Scenario, options: {
  resolvePromotionPosture?: ResolvePromotionPosture
  baseline?: boolean
  inspect?: (fixture: ReturnType<typeof createPromotionFloorFixture>) => void
} = {}) {
  const root = mkdtempSync(join(tmpdir(), '416-v51-reference-'))
  const knowledgeRoot = join(root, 'agent-qa-knowledge')
  const fixture = createPromotionFloorFixture({ knowledgeRoot })
  const gate = vi.mocked(evaluatePromotionGate)
  gate.mockClear()
  function storeFor(sourceRunId?: string) {
    const lease = acquireWriterLease(knowledgeRoot)
    if (lease.kind !== 'acquired') throw new Error('expected reference writer lease')
    return createLocalKnowledgeStore({
      knowledgeRoot, executionContext: 'local-interactive',
      epoch: lease.epoch, writerLeaseId: lease.leaseId, sourceBuildOrdinal: 43,
      ...(sourceRunId === undefined ? {} : { sourceRunId }),
      ...(options.resolvePromotionPosture === undefined ? {} : { resolvePromotionPosture: options.resolvePromotionPosture }),
    })
  }
  try {
    const caution = scenario.startsWith('caution/')
    const seed = scenario.replaceAll('/', '-')
    let refusal: { door2: 'refused'; reason: string } | undefined
    if (scenario.endsWith('door3-drain')) {
      await fixture.drainWithoutModel(caution ? fixture.cautionProjection(seed) : fixture.selectorProjection(seed),
        'local-interactive', options.resolvePromotionPosture === undefined ? {} : {
          resolvePromotionPosture: options.resolvePromotionPosture,
        })
    } else {
      const { draft, published } = caution ? fixture.publishHeldCaution(seed) : fixture.publishHeldCandidate(seed)
      if (scenario.endsWith('door1-promote')) {
        const store = storeFor()
        await store.commit([{ kind: 'Confirm', origin: 'agent', scope: draft.scope,
          citedIds: [published.id], targetId: published.id,
          evidenceToken: asEvidenceToken('held-checkout-confirm'),
          authorship: { path: 'deterministic-fallback', executionContext: 'local-interactive' } }])
        const { dir, bundle } = fixture.onlyBundle()
        evaluatePromotionGate(assemblePromotionGateInput({ knowledgeRoot, bundleDir: dir, bundle,
          ...(options.resolvePromotionPosture === undefined ? {} : { resolvePromotionPosture: options.resolvePromotionPosture }) }))
        if (options.baseline) {
          await expect(store.promote(published.id)).rejects.toMatchObject({ reason: 'gate1-receipt-required' })
        } else {
          await store.promote(published.id)
        }
      } else {
        const sourceRunId = 'run-canary-disposition'
        const outcome: CanaryOutcome = { candidateId: published.id, runOutcome: 'positive', benefit: 'rode-along', stateValidity: 'unknown',
          runId: sourceRunId, testId: 'checkout::happy-path', testIndex: 0, buildOrdinal: 43,
          stepIndex: 2, briefDigest: 'brief-digest-canary-disposition',
          attribution: 'The served checkout hypothesis was exercised by the attributed step.',
          exercisedAnchor: draft.anchors[0]! }
        try { await storeFor(sourceRunId).recordCanaryOutcome(outcome) }
        catch (error) {
          if (!caution) throw error
          if (!(error instanceof Error) || !('reason' in error) || typeof error.reason !== 'string') throw error
          refusal = { door2: 'refused', reason: error.reason }
        }
      }
    }
    const candidates = gate.mock.calls.flatMap(([input], index) =>
      input.status === 'candidate' ? [gate.mock.results[index]!] : [])
    const last = candidates.at(-1)
    if (last?.type !== 'return') throw new Error(`${scenario}: no candidate gate decision captured`)
    const verdictBefore = project(last.value as PromotionGateVerdict)
    const { dir, bundle } = fixture.onlyBundle()
    const trust = deriveBundleTrust(bundle)
    if (scenario === 'caution/door2-canary' && trust.status === 'candidate' && verdictBefore.verdict === 'hold') {
      refusal = { door2: 'refused', reason: verdictBefore.reason! }
    }
    const result = { outcomes: readFileSync(join(dir, 'evidence/outcomes.jsonl'), 'utf8'),
      trust: canonicalJson(trust), status: trust.status, verdictBefore,
      promotedEvents: bundle.events.filter(event => event.type === 'promoted').length,
      ...(refusal === undefined ? {} : refusal) }
    options.inspect?.(fixture)
    return result
  } finally { rmSync(root, { recursive: true, force: true }) }
}
describe('416 v51 reference across the three real doors', () => {
  it('compares each scenario to the immutable pristine reference', async () => {
    const actual: Record<string, Awaited<ReturnType<typeof capture>>> = {}
    for (const scenario of scenarios) actual[scenario] = await capture(scenario)
    const file = fileURLToPath(new URL('./fixtures/416-v51-reference.json', import.meta.url))
    if (!existsSync(file)) {
      if (process.env.V51_REFERENCE_WRITE !== '1') throw new Error('416-v51-reference.json is absent; run once with V51_REFERENCE_WRITE=1 on the PRISTINE pre-416 tree')
      writeFileSync(file, JSON.stringify(JSON.parse(canonicalJson(actual)), null, 2) + '\n')
    }
    const expected = JSON.parse(readFileSync(file, 'utf8'))
    for (const scenario of scenarios) expect(actual[scenario], scenario).toEqual(expected[scenario])
  })
})

describe('416 D-06 — PROM-06 regression: single-model, empty corpus, real store, three doors', () => {
  const hosts = ['no resolver', 'absent-root resolver', 'resolved floor posture'] as const
  for (const host of hosts) {
    for (const scenario of scenarios) {
      it(`${host}: ${scenario} preserves v51 bytes with only the promotion manifest difference`, async () => {
        const file = fileURLToPath(new URL('./fixtures/416-v51-reference.json', import.meta.url))
        const reference = JSON.parse(readFileSync(file, 'utf8'))[scenario] as Awaited<ReturnType<typeof capture>>
        let baselineManifest: BundleManifest | undefined
        // Independent bundle, same builder and seed, held BEFORE promotion. Replay only the
        // immutable reference events through the writer; never derive this manifest from live gates.
        await capture(scenario, {
          resolvePromotionPosture: () => resolvedPromotionPosture(), baseline: true,
          inspect(fixture) {
            const before = fixture.onlyBundle()
            expect(readGateReceipts(before.dir, before.bundle.manifest.id)).toBeUndefined()
            expect(before.bundle.events.some(event => event.type === 'promoted')).toBe(false)
            for (const line of reference.outcomes.trimEnd().split('\n')) {
              const event = BundleOutcomeEventSchema.parse(JSON.parse(line))
              expect(appendOutcomeEvent(fixture.outcomeAppendConfig(), asRecordId(before.bundle.manifest.id), event).kind)
                .toBe(event.type === 'promoted' ? 'appended' : 'duplicate')
            }
            const baseline = fixture.onlyBundle()
            expect(readFileSync(join(baseline.dir, 'evidence/outcomes.jsonl'), 'utf8')).toBe(reference.outcomes)
            expect(canonicalJson(deriveBundleTrust(baseline.bundle))).toBe(reference.trust)
            expect(verifyBundleIntegrity(baseline.dir)).toEqual({ ok: true, violations: [] })
            baselineManifest = baseline.bundle.manifest
          },
        })
        expect(baselineManifest).toBeDefined()
        const resolver = host === 'no resolver' ? undefined : vi.fn(() => host === 'absent-root resolver'
          ? undefined : resolvedPromotionPosture({
            replayGateAvailable: false, gateSetNonEmpty: false, gateSetVerdict: 'empty-gate-set',
            counts: { natural: 0, heldOutShared: 0, heldOutPrivate: 0, adversarial: 0, excludedCount: 0 },
            judge: { capable: false, reason: 'no-judge-configured' },
            canary: { kind: 'not-provided', rarePathEligible: false },
          }))
        const actual = await capture(scenario, {
          ...(resolver === undefined ? {} : { resolvePromotionPosture: resolver }),
          inspect(fixture) {
            const { dir, bundle } = fixture.onlyBundle()
            expect(verifyBundleIntegrity(dir)).toEqual({ ok: true, violations: [] })
            const lines = readGateReceipts(dir, bundle.manifest.id)
            if (reference.promotedEvents === 0) {
              expect(lines).toBeUndefined()
              expect(bundle.manifest).toEqual(baselineManifest)
              return
            }
            expect(reference.promotedEvents).toBe(1)
            expect(lines).toHaveLength(1)
            expect(lines![0]).toMatchObject({ kind: 'promotion', candidateId: bundle.manifest.id,
              promotionPath: 'deterministic-verdict-floor', citedReceiptDigests: [] })
            const { mutableStateHash: expectedHash, ...expectedOther } = baselineManifest!
            const { mutableStateHash: actualHash, contentHashes, ...actualOther } = bundle.manifest
            const { ['evidence/gates.jsonl']: gatesHash, ...otherContentHashes } = contentHashes
            expect(gatesHash).toMatch(/^[a-f0-9]{64}$/)
            expect(actualHash).not.toBe(expectedHash)
            expect({ ...actualOther, contentHashes: otherContentHashes }).toEqual(expectedOther)
          },
        })
        expect(actual).toEqual(reference)
        if (resolver !== undefined) expect(resolver).toHaveBeenCalled()
      })
    }
  }
})
