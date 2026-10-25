import { effectivePriorDigest } from '../../trust-prior-context.js'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { GATE_RECEIPT_SCHEMA_VERSION, asEvidenceToken, asRecordId, canonicalJson, stampReceiptDigest, type Delta, type TrustPriorTable } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeBundleDraftFixture } from '../../__tests__/fixtures/bundle-fixture.js'
import { deriveBundleTrust, loadBundle } from '../../bundle-read.js'
import { enumerateBundleDirs } from '../../bundle-scan.js'
import { indexDbPath } from '../../index-open.js'
import { acquireWriterLease, releaseLease } from '../../lease/writer-lease.js'
import { commitCurationDelta } from '../commit.js'
import { createLocalKnowledgeStore, type CreateLocalKnowledgeStoreConfig } from '../knowledge-store.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const prior = (): TrustPriorTable => ({ 'agent-verified': { alpha: 2.7, beta: 0.3 } })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-prior-store-'))
  roots.push(root)
  const knowledgeRoot = join(root, 'knowledge')
  const lease = acquireWriterLease(knowledgeRoot)
  if (lease.kind !== 'acquired') throw new Error('fixture lease refused')
  const config: CreateLocalKnowledgeStoreConfig = {
    knowledgeRoot, writerLeaseId: lease.leaseId,
    epoch: lease.epoch, executionContext: 'local-interactive', sourceBuildOrdinal: 43,
  }
  const bundle = makeBundleDraftFixture({ subtype: 'content' })
  const delta: Delta = { kind: 'Add', origin: 'agent', scope: bundle.scope, citedIds: [], bundle,
    authorship: { path: 'llm', model: { id: 'prior-store-fixture' }, executionContext: 'local-interactive' } }
  return { config, delta, release: () => releaseLease({ knowledgeRoot, leaseId: lease.leaseId }) }
}

function persisted(knowledgeRoot: string) {
  const [entry] = enumerateBundleDirs(knowledgeRoot)
  if (entry === undefined) throw new Error('fixture bundle missing')
  const loaded = loadBundle(entry.dir)
  if (loaded.kind !== 'loaded') throw new Error('fixture bundle refused')
  const db = new DatabaseSync(indexDbPath(knowledgeRoot), { readOnly: true })
  try { return { entry, bundle: loaded.bundle, row: { ...db.prepare('SELECT * FROM records WHERE bundle_id = ?').get(loaded.bundle.manifest.id)! } } }
  finally { db.close() }
}

describe('420 store prior snapshot', () => {
  it('resolves once at construction and copies and freezes the table and rows', async () => {
    const f = fixture()
    const mutable = prior()
    const resolver = vi.fn().mockReturnValueOnce(mutable).mockReturnValue({ 'agent-verified': { alpha: 0, beta: 3 } })
    const observed: (TrustPriorTable | undefined)[] = []
    const operation: typeof commitCurationDelta = (deps, job, checkpoint) => {
      observed.push((deps as typeof deps & { priors?: TrustPriorTable }).priors)
      return commitCurationDelta(deps, job, checkpoint)
    }
    const store = createLocalKnowledgeStore({ ...f.config, resolveTrustPriors: resolver, operations: { commitCurationDelta: operation } })
    expect(resolver).toHaveBeenCalledTimes(1)
    mutable['agent-verified']!.alpha = 0
    await store.commit([f.delta])
    await store.commit([{ kind: 'Noop', origin: 'agent', scope: f.delta.scope, citedIds: [] }])
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(observed[0]).toEqual(prior())
    expect(observed[1]).toBe(observed[0])
    expect(observed[0]).not.toBe(mutable)
    expect(Object.isFrozen(observed[0])).toBe(true)
    expect(Object.isFrozen(observed[0]!['agent-verified'])).toBe(true)
    expect(persisted(f.config.knowledgeRoot).row.trust).toBe(0.925)
    f.release()
  })

  it('projects actual commits using the supplied prior', async () => {
    const f = fixture()
    const options = { ...f.config, resolveTrustPriors: () => prior() }
    await createLocalKnowledgeStore(options).commit([f.delta])
    const actual = persisted(f.config.knowledgeRoot)
    expect(actual.row.trust).toBe(0.925)
    expect(actual.row.trust).toBe(deriveBundleTrust(actual.bundle, prior()).trust)
    f.release()
  })

  it('keeps promotion and active revalidation projections on the original snapshot', async () => {
    const f = fixture()
    const mutable = prior()
    const resolver = vi.fn(() => mutable)
    const options = { ...f.config, resolveTrustPriors: resolver }
    const store = createLocalKnowledgeStore(options)
    await store.commit([f.delta])
    const { bundle } = persisted(f.config.knowledgeRoot)
    mutable['agent-verified']!.alpha = 0
    await expect(store.promote(asRecordId(bundle.manifest.id), [stampReceiptDigest({ schemaVersion: GATE_RECEIPT_SCHEMA_VERSION,
      gate: 3, candidateId: asRecordId(bundle.manifest.id), verdict: 'pass', producedAtOrdinal: 43,
      producedBy: { opId: 'prior-promotion' }, runId: 'prior-run', mark: 'confirmed-bug' })]))
      .resolves.toMatchObject({ kind: 'promoted' })
    const first = persisted(f.config.knowledgeRoot)
    const bytes = readFileSync(join(first.entry.dir, 'evidence/outcomes.jsonl'), 'utf8')
    await expect(store.promote(asRecordId(bundle.manifest.id))).resolves.toMatchObject({ kind: 'already-active' })
    expect(readFileSync(join(first.entry.dir, 'evidence/outcomes.jsonl'), 'utf8')).toBe(bytes)
    expect(persisted(f.config.knowledgeRoot).row.trust).toBe(0.925)
    expect(resolver).toHaveBeenCalledTimes(1)
    f.release()
  })

  it('keeps negative canary appends and retries on the original snapshot', async () => {
    const f = fixture()
    const resolver = vi.fn(() => prior())
    const options = { ...f.config, resolveTrustPriors: resolver }
    const store = createLocalKnowledgeStore(options)
    await store.commit([f.delta])
    const { bundle } = persisted(f.config.knowledgeRoot)
    const outcome = { candidateId: asRecordId(bundle.manifest.id), runId: 'prior-canary', testIndex: 0,
      stepIndex: 0, buildOrdinal: 44, runOutcome: 'negative' as const, testId: 'prior-test',
      benefit: 'exercised-harmed' as const,
      briefDigest: 'prior-brief', attribution: 'exercised candidate',
      exercisedAnchor: bundle.frontmatter.anchors[0]!.raw }
    await store.recordCanaryOutcome(outcome)
    const first = persisted(f.config.knowledgeRoot)
    expect(first.row.trust).toBe(0.74)
    expect(first.row.contradicted).toBe(1)
    await store.recordCanaryOutcome(outcome)
    expect(persisted(f.config.knowledgeRoot).row).toEqual(first.row)
    expect(resolver).toHaveBeenCalledTimes(1)
    f.release()
  })

  it('preserves absent and empty prior event bytes and every non-trust column', async () => {
    const results = []
    for (const priors of [undefined, {}, prior()]) {
      const f = fixture()
      const options = { ...f.config, ...(priors === undefined ? {} : { resolveTrustPriors: () => priors }) }
      const store = createLocalKnowledgeStore(options)
      await store.commit([f.delta])
      const first = persisted(f.config.knowledgeRoot)
      await store.commit([{ kind: 'Confirm', origin: 'system', scope: f.delta.scope, citedIds: [asRecordId(first.bundle.manifest.id)], targetId: asRecordId(first.bundle.manifest.id), evidenceToken: asEvidenceToken('prior-confirm') }])
      const actual = persisted(f.config.knowledgeRoot)
      const { trust, trust_prior_digest: priorDigest, ...rest } = actual.row
      expect(priorDigest).toBe(effectivePriorDigest(priors))
      results.push({ trust, rest, events: canonicalJson(actual.bundle.events) })
      f.release()
    }
    expect(results[0]).toEqual(results[1])
    expect(results[2]!.rest).toEqual(results[0]!.rest)
    expect(results[2]!.events).toBe(results[0]!.events)
    expect(results[2]!.trust).not.toBe(results[0]!.trust)
  })

  it('rejects malformed host data before any store mutation', () => {
    const f = fixture()
    const options = { ...f.config, resolveTrustPriors: () => ({ 'agent-verified': { alpha: NaN, beta: 1 } }) }
    expect(() => createLocalKnowledgeStore(options)).toThrow('Invalid trust prior table')
    expect(enumerateBundleDirs(f.config.knowledgeRoot)).toEqual([])
    f.release()
  })
})
