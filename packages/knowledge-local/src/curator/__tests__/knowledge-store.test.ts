import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DISTILLED_OBSERVATION_SCHEMA_VERSION,
  asEvidenceToken,
  asRecordId,
  BundleOutcomeEventSchema,
  canonicalJson,
  eventDedupKey,
  sha256hex,
  type BundleDiscriminant,
  type BundleDraft,
  type BundleOutcomeEvent,
  type Delta,
  type DistilledObservation,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { appendOutcomeEvent } from '../../bundle-append.js'
import { deriveBundleTrust, loadBundle } from '../../bundle-read.js'
import {
  publishBundle,
  type BundleStoreConfig,
  type PublishBundleInput,
} from '../../bundle-publish.test-helper.js'
import { enumerateBundleDirs } from '../../bundle-scan.js'
import { openIndexReaderConnection } from '../../index-open.js'
import { KnowledgeUnsupportedDeltaError } from '../../index.js'
import { acquireWriterLease } from '../../lease/writer-lease.js'
import { claimedRoot } from '../../queue/queue-layout.js'
import {
  makeBundleDraftFixture,
  makeProcedureBundleDraftFixture,
} from '../../__tests__/fixtures/bundle-fixture.js'
import { derivePromotedEvidenceToken } from '../commit.js'
import {
  createLocalKnowledgeStore,
  type CreateLocalKnowledgeStoreConfig,
} from '../knowledge-store.js'

const FACT_ANCHORS = [
  { t: 'el', role: 'button', name: 'Checkout', ordinal: 0 },
  { t: 'page', route: '/checkout' },
  { t: 'selector', literal: '[data-testid="checkout"]' },
] as const

const ELEMENT_OBSERVATION: DistilledObservation = {
  schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
  step: { naturalKey: 'checkout-click', ordinal: 0 },
  platform: 'web',
  element: { naturalKey: 'button:checkout:0' },
  locator: { selector: '[data-testid="checkout"]' },
  observedAtOrdinal: 42,
}

describe('KnowledgePort procedure authoring boundary', () => {
  let root: string
  let knowledgeRoot: string
  let epoch: number
  let leaseId: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-store-procedure-boundary-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    const lease = acquireWriterLease(knowledgeRoot)
    if (lease.kind !== 'acquired') throw new Error('expected a fresh writer lease')
    epoch = lease.epoch
    leaseId = lease.leaseId
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function storeConfig(
    overrides: Partial<CreateLocalKnowledgeStoreConfig> = {},
  ): CreateLocalKnowledgeStoreConfig {
    return {
      knowledgeRoot,
      executionContext: 'local-interactive',
      epoch,
      writerLeaseId: leaseId,
      sourceBuildOrdinal: 43,
      ...overrides,
    }
  }

  function addDelta(bundle: BundleDraft): Extract<Delta, { kind: 'Add' }> {
    return {
      kind: 'Add',
      origin: 'agent',
      scope: bundle.scope,
      citedIds: [],
      authorship: {
        path: 'llm',
        model: { id: 'knowledge-store-procedure-boundary-fixture' },
        executionContext: 'local-interactive',
      },
      bundle,
    }
  }

  function procedureAdd(): Extract<Delta, { kind: 'Add' }> {
    return addDelta(makeProcedureBundleDraftFixture())
  }

  function procedureSupersede(): Extract<Delta, { kind: 'Supersede' }> {
    const newBundle = makeProcedureBundleDraftFixture({
      summary: 'Superseding sign-in procedure',
    })
    const victimId = asRecordId('missing-procedure-victim')
    return {
      kind: 'Supersede',
      origin: 'agent',
      scope: newBundle.scope,
      citedIds: [victimId],
      authorship: {
        path: 'llm',
        model: { id: 'knowledge-store-procedure-boundary-fixture' },
        executionContext: 'local-interactive',
      },
      victimId,
      newBundle,
      evidenceToken: asEvidenceToken('procedure-supersede-evidence'),
    }
  }

  async function expectUnsupported(
    submission: Promise<void>,
    deltaKind: Delta['kind'],
  ): Promise<void> {
    let thrown: unknown
    try {
      await submission
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(KnowledgeUnsupportedDeltaError)
    expect(thrown).toMatchObject({
      name: 'KnowledgeUnsupportedDeltaError',
      deltaKind,
      reason: 'procedure-evidence-unsupported',
    })
  }

  function relativePaths(dir: string, prefix = ''): string[] {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      return entry.isDirectory()
        ? [relativePath, ...relativePaths(join(dir, entry.name), relativePath)]
        : [relativePath]
    })
  }

  it('rejects a procedure Add through commit with the typed unsupported-delta contract', async () => {
    const store = createLocalKnowledgeStore(storeConfig())

    await expectUnsupported(store.commit([procedureAdd()]), 'Add')
  })

  it('rejects a procedure Add through proposeDeltas with the same typed contract', async () => {
    const store = createLocalKnowledgeStore(storeConfig())

    await expectUnsupported(store.proposeDeltas([procedureAdd()]), 'Add')
  })

  it('rejects a procedure-authored Supersede with its own delta kind', async () => {
    const store = createLocalKnowledgeStore(storeConfig())

    await expectUnsupported(store.commit([procedureSupersede()]), 'Supersede')
  })

  it('rejects before materializing any claimed candidate, payload, or procedure bundle', async () => {
    const operation = vi.fn(() => ({ kind: 'noop', reason: 'port-fixture' } as const))
    const store = createLocalKnowledgeStore(storeConfig({
      operations: { commitCurationDelta: operation },
    }))

    await store.commit([procedureAdd()]).catch(() => undefined)

    const paths = relativePaths(knowledgeRoot)
    expect(operation).not.toHaveBeenCalled()
    expect(existsSync(claimedRoot(knowledgeRoot))).toBe(false)
    expect(paths.filter((path) => path.includes('/claimed/') || path.endsWith('payload.json')))
      .toEqual([])
    expect(enumerateBundleDirs(knowledgeRoot)).toEqual([])
  })

  it('keeps a supported fact Add committing through the public store', async () => {
    const fact = makeBundleDraftFixture({
      kind: 'fact',
      subtype: 'content',
      summary: 'Supported public-store fact',
      body: 'This fact remains supported through the public KnowledgePort bridge.',
    })
    const store = createLocalKnowledgeStore(storeConfig())

    await expect(store.commit([addDelta(fact)])).resolves.toBeUndefined()

    const [entry] = enumerateBundleDirs(knowledgeRoot)
    expect(entry).toBeDefined()
    const loaded = loadBundle(entry!.dir)
    expect(loaded).toMatchObject({
      kind: 'loaded',
      bundle: {
        frontmatter: { kind: 'fact', subtype: 'content' },
        summary: 'Supported public-store fact',
      },
    })

    // …and the SUCCESS path materializes no claimed tree either (387-17, CR-02″).
    //
    // The refusal case above pins that a REJECTED delta writes nothing. This is the other half,
    // and it was found by measurement rather than by reasoning: with `bridgeDelta` made
    // write-free, `preCopyArtifacts` still passed `job.candidateDir`-nested preflight path to
    // `copyArtifacts`, whose opening `mkdirSync(…, { recursive: true })` re-created the whole
    // `memory/queue/claimed/<lease>/<candidateId>/` chain for a job with NOTHING to copy.
    // `markDone` removed the candidate and the lease dir on the way out, so the only survivor was
    // `memory/queue/claimed` itself — invisible to every bundle-tree gate and to a files-only
    // listing, which is precisely the blind spot CR-02″ lived in one round earlier.
    //
    // OBSERVED before the `preCopyArtifacts` empty short-circuit landed: `existsSync(claimedRoot)`
    // was `true` here. Removing that short-circuit reds this line.
    expect(
      existsSync(claimedRoot(knowledgeRoot)),
      'a port-bridged commit that succeeds must leave no claimed queue tree behind either',
    ).toBe(false)
  })
})

describe('KnowledgePort promote deterministic gate', () => {
  let root: string
  let knowledgeRoot: string
  let epoch: number
  let leaseId: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-store-promote-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    // CR-02: promote() now runs its whole gate-and-write body inside the exact-authority
    // fence, so this fixture has to hold the lease it mutates under rather than name one.
    const lease = acquireWriterLease(knowledgeRoot)
    if (lease.kind !== 'acquired') throw new Error('expected a fresh writer lease')
    epoch = lease.epoch
    leaseId = lease.leaseId
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function bundleConfig(): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey: 'storefront',
      writerLeaseId: 'knowledge-store-test',
    }
  }

  function confirmedEvent(suffix: string, buildOrdinal = 42): BundleOutcomeEvent {
    return BundleOutcomeEventSchema.parse({
      type: 'confirmed',
      evidenceToken: `confirmed-${suffix}`,
      curationJobId: `confirmed-${suffix}-job`,
      buildOrdinal,
      origin: 'agent-verified',
    })
  }

  function seedCandidate(options: {
    kind?: 'fact' | 'procedure'
    confirmed?: boolean
    withheld?: boolean
    observations?: readonly DistilledObservation[]
  } = {}) {
    const kind = options.kind ?? 'fact'
    const draft: BundleDraft = kind === 'fact'
      ? {
          kind,
          subtype: 'selector',
          anchors: [...FACT_ANCHORS],
          scope: { tier: 'product', key: 'storefront' },
          summary: 'Checkout button selector',
          body: 'The checkout button was resolved and verified.',
          distilledEvidenceRef: { id: 'checkout-evidence', sha: 'a'.repeat(64) },
          originStage: 'run-curation',
        }
      : {
          kind,
          anchors: [
            { t: 'flow', name: 'Checkout flow' },
            { t: 'page', route: '/checkout' },
          ],
          scope: { tier: 'product', key: 'storefront' },
          summary: 'Complete checkout',
          body: 'Open the cart and activate checkout.',
          distilledEvidenceRef: { id: 'checkout-procedure-evidence', sha: 'b'.repeat(64) },
          originStage: 'run-curation',
        }
    const discriminant: BundleDiscriminant = kind === 'fact'
      ? {
          kind,
          subtype: 'selector',
          elementRef: { role: 'button', name: 'Checkout' },
        }
      : { kind, flowName: 'Checkout flow', stepSignature: 'cart>checkout' }
    const input: PublishBundleInput = {
      draft,
      discriminant,
      originClass: 'agent-verified',
      createdAtOrdinal: 42,
      screenStates: [],
      initialEvents: options.confirmed === false ? [] : [confirmedEvent(kind)],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: 'promote-run',
        testId: 'promote-test',
        stepIndex: 0,
        curationJobId: 'seed-candidate',
        sourceBuildOrdinal: 42,
        ...(options.withheld === true ? { withheld: true } : {}),
      },
      artifacts: [],
      evidenceMarkdown: 'Deterministically observed during checkout.\n',
      distilledObservations: options.observations
        ?? (kind === 'fact' ? [ELEMENT_OBSERVATION] : []),
    }
    const published = publishBundle(bundleConfig(), input)
    if (published.kind !== 'published') {
      throw new Error(`expected candidate publish, got ${published.kind}`)
    }
    return published
  }

  function storeConfig(
    overrides: Partial<CreateLocalKnowledgeStoreConfig> = {},
  ): CreateLocalKnowledgeStoreConfig {
    return {
      knowledgeRoot,
      executionContext: 'local-interactive',
      epoch,
      writerLeaseId: leaseId,
      sourceBuildOrdinal: 43,
      ...overrides,
    }
  }

  function loadedTrust(bundleDir: string) {
    const loaded = loadBundle(bundleDir)
    if (loaded.kind !== 'loaded') throw new Error(`expected loaded bundle, got ${loaded.kind}`)
    return { bundle: loaded.bundle, trust: deriveBundleTrust(loaded.bundle) }
  }

  it('promotes after later durable evidence completes the same gate and re-projects active', async () => {
    const published = seedCandidate({ confirmed: false })
    const store = createLocalKnowledgeStore(storeConfig())

    await expect(store.promote(published.id)).rejects.toMatchObject({
      name: 'KnowledgePromotionError',
      reason: 'no-confirmed-evidence',
    })
    expect(loadedTrust(published.dir).trust.status).toBe('candidate')

    expect(
      appendOutcomeEvent(bundleConfig(), published.id, confirmedEvent('later', 43)),
    ).toEqual({ kind: 'appended' })

    await store.promote(published.id)

    const loaded = loadedTrust(published.dir)
    expect(loaded.trust.status).toBe('active')
    expect(loaded.bundle.events.filter(({ type }) => type === 'promoted')).toHaveLength(1)
    const reader = openIndexReaderConnection(knowledgeRoot)
    try {
      expect(
        reader.db.prepare('SELECT status FROM records WHERE bundle_id = ?').get(published.id),
      ).toMatchObject({ status: 'active' })
    } finally {
      reader.db.close()
    }
  })

  it.each([
    {
      label: 'withheld provenance',
      options: { withheld: true },
      reason: 'withheld',
    },
    {
      label: 'procedure kind',
      options: { kind: 'procedure' as const },
      reason: 'kind-excluded',
    },
    {
      label: 'missing element observation',
      options: { observations: [] },
      reason: 'no-element-observation',
    },
  ])('never bypasses the gate for $label', async ({ options, reason }) => {
    const published = seedCandidate(options)
    const store = createLocalKnowledgeStore(storeConfig())

    await expect(store.promote(published.id)).rejects.toMatchObject({
      name: 'KnowledgePromotionError',
      reason,
    })

    const loaded = loadedTrust(published.dir)
    expect(loaded.trust.status).toBe('candidate')
    expect(loaded.bundle.events.filter(({ type }) => type === 'promoted')).toHaveLength(0)
  })

  it('re-evaluates propose-only posture at call time and refuses regardless of evidence', async () => {
    const published = seedCandidate()
    const config = storeConfig()
    const store = createLocalKnowledgeStore(config)
    config.executionContext = 'ci'

    await expect(store.promote(published.id)).rejects.toMatchObject({
      name: 'KnowledgePromotionError',
      reason: 'propose-only',
    })

    const loaded = loadedTrust(published.dir)
    expect(loaded.trust.status).toBe('candidate')
    expect(loaded.bundle.events.filter(({ type }) => type === 'promoted')).toHaveLength(0)
  })

  it('is an idempotent noop after the first promoted append', async () => {
    const published = seedCandidate()
    const store = createLocalKnowledgeStore(storeConfig())

    await store.promote(published.id)
    await store.promote(published.id)

    const loaded = loadedTrust(published.dir)
    expect(loaded.trust.status).toBe('active')
    expect(loaded.bundle.events.filter(({ type }) => type === 'promoted')).toHaveLength(1)
  })

  function recordsRowStatus(bundleId: string): string | undefined {
    const reader = openIndexReaderConnection(knowledgeRoot)
    try {
      const row = reader.db
        .prepare('SELECT status FROM records WHERE bundle_id = ?')
        .get(bundleId) as { status: string } | undefined
      return row?.status
    } finally {
      reader.db.close()
    }
  }

  function crashWindowRetraction(): BundleOutcomeEvent {
    // Simulates the reachable production window: a crash between a rollback's
    // confirmation retraction and its Plan-23 promotion cascade leaves canonical
    // active-with-zero-support until replay (CR-01).
    return BundleOutcomeEventSchema.parse({
      type: 'retracted',
      evidenceToken: 'crash-window-retraction',
      curationJobId: 'rollback-crash-window',
      buildOrdinal: 44,
      retractsEvidenceToken: 'confirmed-fact',
      retractsCurationJobId: 'confirmed-fact-job',
      rollbackReceiptId: 'rollback:crash-window',
    })
  }

  it('keeps the supported active noop contract and heals the projection row (control)', async () => {
    const published = seedCandidate()
    const store = createLocalKnowledgeStore(storeConfig())

    await store.promote(published.id)
    await store.promote(published.id)

    const loaded = loadedTrust(published.dir)
    expect(loaded.trust.status).toBe('active')
    expect(loaded.bundle.events.filter(({ type }) => type === 'promoted')).toHaveLength(1)
    expect(loaded.bundle.events.filter(({ type }) => type === 'retracted')).toHaveLength(0)
    expect(recordsRowStatus(published.id)).toBe('active')
  })

  it('re-validates stale active authority: heals promoted events and refuses instead of attesting', async () => {
    const published = seedCandidate()
    const store = createLocalKnowledgeStore(storeConfig())
    await store.promote(published.id)

    expect(
      appendOutcomeEvent(bundleConfig(), published.id, crashWindowRetraction()),
    ).toEqual({ kind: 'appended' })
    const stale = loadedTrust(published.dir)
    expect(stale.trust.status).toBe('active')
    const promotedEvent = stale.bundle.events.find(({ type }) => type === 'promoted')
    if (promotedEvent === undefined) throw new Error('expected a surviving promoted event')

    await expect(store.promote(published.id)).rejects.toMatchObject({
      name: 'KnowledgePromotionError',
      reason: 'no-confirmed-evidence',
    })

    const healed = loadedTrust(published.dir)
    expect(healed.trust.status).toBe('candidate')
    const healRetractions = healed.bundle.events.filter(
      (event) =>
        event.type === 'retracted'
        && event.rollbackReceiptId === `promote-heal:${published.id}`,
    )
    expect(healRetractions).toEqual([{
      type: 'retracted',
      evidenceToken: sha256hex(canonicalJson({
        healedPromotedEventKey: eventDedupKey(promotedEvent),
        candidateId: published.id,
      })),
      curationJobId: `promote-heal:${published.id}`,
      buildOrdinal: 43,
      retractsEvidenceToken: derivePromotedEvidenceToken(published.id),
      retractsCurationJobId: `promote:${published.id}`,
      rollbackReceiptId: `promote-heal:${published.id}`,
    }])
    expect(recordsRowStatus(published.id)).toBe('candidate')
  })

  it('replays the heal refusal as a dedup no-op without duplicate retractions', async () => {
    const published = seedCandidate()
    const store = createLocalKnowledgeStore(storeConfig())
    await store.promote(published.id)
    expect(
      appendOutcomeEvent(bundleConfig(), published.id, crashWindowRetraction()),
    ).toEqual({ kind: 'appended' })

    await expect(store.promote(published.id)).rejects.toMatchObject({
      name: 'KnowledgePromotionError',
      reason: 'no-confirmed-evidence',
    })
    const afterHeal = loadedTrust(published.dir)
    expect(afterHeal.bundle.events.filter(({ type }) => type === 'retracted')).toHaveLength(2)

    await expect(store.promote(published.id)).rejects.toMatchObject({
      name: 'KnowledgePromotionError',
      reason: 'no-confirmed-evidence',
    })

    const replayed = loadedTrust(published.dir)
    expect(replayed.trust.status).toBe('candidate')
    expect(replayed.bundle.events.filter(({ type }) => type === 'retracted')).toHaveLength(2)
    expect(replayed.bundle.events.filter(({ type }) => type === 'promoted')).toHaveLength(1)
  })
})
