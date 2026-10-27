import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
  QUARANTINE_UNASSIGNED_OWNER,
  QuarantineLedgerVersionError,
  asRunId,
  BundleOutcomeEventSchema,
  DEFAULT_EMBEDDING_PROFILE,
  canonicalJson,
  slugBranch,
  type Anchor,
  type CompletedRunHandoff,
  type ScopeKey,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../embedder-acquire.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../embedder-acquire.js')>(),
  acquireEmbedder: async () => ({ kind: 'lexical-only' as const }),
}))

import {
  createAuthoringReader,
  applyRunOutcomes,
  openIndexWriter,
  projectRunOutcomes,
  QUARANTINE_LEDGER_FILENAME,
  rebuildIndex,
  type BundleStoreConfig,
  type EmbedderPort,
} from '../../index.js'
import { publishBundle } from '../../bundle-publish.test-helper.js'
import { makeBundleDraftFixture } from '../../__tests__/fixtures/bundle-fixture.js'

const PRODUCT = 'dense-authoring-storefront'
const SCOPE = { tier: 'product', key: PRODUCT } as const
const BLOG_PRODUCT = 'dense-authoring-blog'
const BLOG_SCOPE = { tier: 'product', key: BLOG_PRODUCT } as const
const DENSE_ONLY_INTENT = 'semantic-only-orchid'

function unitVector(): Float32Array {
  const vector = new Float32Array(DEFAULT_EMBEDDING_PROFILE.dim)
  vector[0] = 1
  return vector
}

const matchingEmbedder: EmbedderPort = {
  async embedDocument(): Promise<Float32Array> {
    return unitVector()
  },
  async embedQuery(): Promise<Float32Array> {
    return unitVector()
  },
}

function outcomeHandoff(input: {
  runId: string
  scope: ScopeKey
  buildOrdinal: number
  filePath: string
  testName: string
  outcome: 'passed' | 'failed'
  anchor?: Anchor
  /** Drives the projection's lifetime flake counter — the exclude that is NOT the ledger's. */
  rootCauseClass?: string
}): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(input.runId),
    scope: input.scope,
    buildOrdinal: input.buildOrdinal,
    executionContext: 'ci',
    aggregateVerdict: input.outcome,
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1_750_000_000_000,
    endedAt: 1_750_000_001_000,
    tests: [{
      testId: `${input.runId}-test`,
      testName: input.testName,
      filePath: input.filePath,
      testIndex: 0,
      outcome: input.outcome,
      steps: input.anchor === undefined
        ? []
        : [{ stepIndex: 0, anchors: [input.anchor] }],
      ...(input.rootCauseClass === undefined ? {} : {
        rootCause: {
          class: input.rootCauseClass,
          producer: 'deterministic-classifier',
          confidence: 1,
          evidence: {
            citedSteps: [], citedAnchors: [], citedArtifacts: [],
            rationale: `fixture ${input.rootCauseClass} root cause`,
          },
          memoryMisdirectionRuledOut: true,
          perTest: 0,
        },
      }),
    }],
  } as unknown as CompletedRunHandoff
}

function foldOutcomeHandoff(knowledgeRoot: string, handoff: CompletedRunHandoff): void {
  const writer = openIndexWriter(knowledgeRoot)
  try {
    applyRunOutcomes(writer.db, projectRunOutcomes(handoff, {
      extractAnchors: (step) => (
        step as unknown as { anchors?: Anchor[] }
      ).anchors ?? [],
    }))
  } finally {
    writer.close()
  }
}

describe('createAuthoringReader dense retrieval', () => {
  let root: string
  let knowledgeRoot: string
  let publishedId: string

  beforeEach(async () => {
    root = join(tmpdir(), `authoring-reader-dense-${randomUUID()}`)
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    const store: BundleStoreConfig = {
      knowledgeRoot,
      productKey: PRODUCT,
      writerLeaseId: 'authoring-reader-dense',
    }
    const outcome = publishBundle(store, {
      draft: makeBundleDraftFixture({
        anchors: [{ t: 'page', route: '/opaque-control' }],
        scope: SCOPE,
        summary: 'Neutral ledger control',
        body: 'Invoking this control performs the recorded action.',
      }),
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'Button', name: 'Neutral ledger' },
      },
      originClass: 'agent-verified',
      createdAtOrdinal: 10,
      screenStates: [],
      initialEvents: [BundleOutcomeEventSchema.parse({
        type: 'promoted',
        evidenceToken: 'dense-authoring-promoted',
        curationJobId: 'dense-authoring-job',
        buildOrdinal: 10,
      })],
      relations: [],
      provenance: {
        mode: 'standalone',
        sourceDescription: 'dense authoring reader fixture',
      },
      artifacts: [],
      evidenceMarkdown: 'Dense authoring reader evidence.\n',
    })
    if (outcome.kind !== 'published') {
      throw new Error(`expected publication, got ${outcome.kind}`)
    }
    publishedId = String(outcome.id)
    await rebuildIndex({ knowledgeRoot, embedder: matchingEmbedder })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('admits a token-disjoint fact only through the injected dense leg', async () => {
    const reader = createAuthoringReader(
      { knowledgeRoot, product: PRODUCT },
      { embedder: matchingEmbedder },
    )

    const brief = await reader.getAuthoringBrief(DENSE_ONLY_INTENT, SCOPE)

    expect(brief.facts.map(({ id }) => String(id))).toEqual([publishedId])
  })

  it('keeps the no-embedder lexical floor byte-identical', async () => {
    const reader = createAuthoringReader({ knowledgeRoot, product: PRODUCT })

    const brief = await reader.getAuthoringBrief(DENSE_ONLY_INTENT, SCOPE)

    expect(canonicalJson(brief)).toBe(canonicalJson({
      exemplars: [],
      procedures: [],
      facts: [],
      cautions: [],
      coverage: {},
      truncation: '',
      admissions: [],
    }))
  })

  it('degrades a throwing dense leg to the lexical floor and closes its reader', async () => {
    const lexicalReader = createAuthoringReader({ knowledgeRoot, product: PRODUCT })
    const lexicalBrief = await lexicalReader.getAuthoringBrief(DENSE_ONLY_INTENT, SCOPE)
    const throwingEmbedder: EmbedderPort = {
      async embedDocument(): Promise<Float32Array> {
        return unitVector()
      },
      async embedQuery(): Promise<Float32Array> {
        throw new Error('dense query failed')
      },
    }
    const degradedReader = createAuthoringReader(
      { knowledgeRoot, product: PRODUCT },
      { embedder: throwingEmbedder },
    )

    const degradedBrief = await degradedReader.getAuthoringBrief(DENSE_ONLY_INTENT, SCOPE)

    expect(canonicalJson(degradedBrief)).toBe(canonicalJson(lexicalBrief))
    await expect(lexicalReader.getAuthoringBrief(DENSE_ONLY_INTENT, SCOPE))
      .resolves.toEqual(lexicalBrief)
  })

  it('joins id-different-from-name projection and discovery into one verified exemplar (WR-02)', async () => {
    const filePath = join(root, 'tests', 'guest-checkout.yaml')
    const testId = 'checkout-guest-1'
    const testName = 'Guest checkout with promo'
    const handoff: CompletedRunHandoff = {
      schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
      runId: asRunId('run-authoring-identity-join'),
      scope: SCOPE,
      buildOrdinal: 12,
      executionContext: 'ci',
      aggregateVerdict: 'passed',
      configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
      startedAt: 1_750_000_000_000,
      endedAt: 1_750_000_001_000,
      tests: [{
        testId,
        testName,
        filePath,
        testIndex: 0,
        outcome: 'passed',
        steps: [],
      }],
    }
    const writer = openIndexWriter(knowledgeRoot)
    try {
      applyRunOutcomes(writer.db, projectRunOutcomes(handoff, {
        extractAnchors: () => [],
      }))
    } finally {
      writer.close()
    }
    const reader = createAuthoringReader(
      { knowledgeRoot, product: PRODUCT },
      { discoverKnownTests: () => [{ filePath, testName }] },
    )

    const brief = await reader.getAuthoringBrief(testName, SCOPE)

    expect(brief.exemplars).toHaveLength(1)
    expect(brief.exemplars[0]).toMatchObject({
      filePath,
      testName,
      unverifiedOutcomes: false,
      passRate: 1,
    })
    expect(brief.exemplars).not.toContainEqual(
      expect.objectContaining({ filePath, unverifiedOutcomes: true }),
    )
  })

  it('keeps projection exemplars and counters inside the requested product scope', async () => {
    const shared = {
      filePath: 'tests/shared-checkout.yaml',
      testName: 'shared checkout path',
    }
    foldOutcomeHandoff(knowledgeRoot, outcomeHandoff({
      runId: 'run-shop-shared-1',
      scope: SCOPE,
      buildOrdinal: 20,
      ...shared,
      outcome: 'passed',
      anchor: { t: 'page', route: '/checkout' },
    }))
    foldOutcomeHandoff(knowledgeRoot, outcomeHandoff({
      runId: 'run-shop-shared-2',
      scope: SCOPE,
      buildOrdinal: 21,
      ...shared,
      outcome: 'passed',
      anchor: { t: 'page', route: '/checkout' },
    }))
    foldOutcomeHandoff(knowledgeRoot, outcomeHandoff({
      runId: 'run-blog-shared',
      scope: BLOG_SCOPE,
      buildOrdinal: 22,
      ...shared,
      outcome: 'passed',
      anchor: { t: 'page', route: '/blog-checkout' },
    }))
    foldOutcomeHandoff(knowledgeRoot, outcomeHandoff({
      runId: 'run-blog-only',
      scope: BLOG_SCOPE,
      buildOrdinal: 23,
      filePath: 'tests/blog-only-checkout.yaml',
      testName: 'blog only checkout path',
      outcome: 'passed',
      anchor: { t: 'page', route: '/checkout' },
    }))

    const reader = createAuthoringReader({ knowledgeRoot, product: PRODUCT })
    const brief = await reader.getAuthoringBrief('checkout path /checkout', SCOPE)

    expect(brief.exemplars.map(({ filePath, testName }) => ({ filePath, testName }))).toEqual([
      shared,
    ])
    expect(brief.exemplars[0]).toMatchObject({
      passRate: 1,
      unverifiedOutcomes: false,
    })
    expect(brief.exemplars[0]?.excerpt).toContain('outcomes 2 pass / 0 fail')
    expect(brief.exemplars[0]?.excerpt).not.toContain('blog-checkout')
  })

  it('does not let a foreign projection row suppress a local never-run test', async () => {
    const localRef = {
      filePath: 'tests/shared-never-run.yaml',
      testName: 'shared never run checkout',
    }
    foldOutcomeHandoff(knowledgeRoot, outcomeHandoff({
      runId: 'run-blog-never-run-name',
      scope: BLOG_SCOPE,
      buildOrdinal: 24,
      ...localRef,
      outcome: 'passed',
    }))
    const reader = createAuthoringReader(
      { knowledgeRoot, product: PRODUCT },
      { discoverKnownTests: () => [localRef] },
    )

    const brief = await reader.getAuthoringBrief('shared never run checkout', SCOPE)

    expect(brief.exemplars).toHaveLength(1)
    expect(brief.exemplars[0]).toMatchObject({
      ...localRef,
      unverifiedOutcomes: true,
    })
    expect(brief.exemplars[0]).not.toHaveProperty('passRate')
  })

  it('keeps anchors tuple-true for old-colliding file/test names (WR-01, ABRF-02)', async () => {
    foldOutcomeHandoff(knowledgeRoot, outcomeHandoff({
      runId: 'run-collide-one',
      scope: SCOPE,
      buildOrdinal: 30,
      filePath: 'a::b',
      testName: 'c',
      outcome: 'passed',
      anchor: { t: 'page', route: '/route-one' },
    }))
    foldOutcomeHandoff(knowledgeRoot, outcomeHandoff({
      runId: 'run-collide-two',
      scope: SCOPE,
      buildOrdinal: 31,
      filePath: 'a',
      testName: 'b::c',
      outcome: 'passed',
      anchor: { t: 'page', route: '/route-two' },
    }))
    const reader = createAuthoringReader({ knowledgeRoot, product: PRODUCT })

    const brief = await reader.getAuthoringBrief('a b c /route-one /route-two', SCOPE)

    expect(brief.exemplars).toHaveLength(2)
    const first = brief.exemplars.find(({ filePath }) => filePath === 'a::b')
    const second = brief.exemplars.find(({ filePath }) => filePath === 'a')
    expect(first).toMatchObject({ testName: 'c', unverifiedOutcomes: false })
    expect(second).toMatchObject({ testName: 'b::c', unverifiedOutcomes: false })
    expect(first?.matchedAnchors).toEqual([{ t: 'page', route: '/route-one' }])
    expect(second?.matchedAnchors).toEqual([{ t: 'page', route: '/route-two' }])
  })

  it('keeps old-colliding discovered tests as two distinct never-run exemplars', async () => {
    const reader = createAuthoringReader(
      { knowledgeRoot, product: PRODUCT },
      {
        discoverKnownTests: () => [
          { filePath: 'a::b', testName: 'c' },
          { filePath: 'a', testName: 'b::c' },
        ],
      },
    )

    const brief = await reader.getAuthoringBrief('a b c', SCOPE)

    expect(brief.exemplars.map(({ filePath, testName }) => ({ filePath, testName })))
      .toEqual(expect.arrayContaining([
        { filePath: 'a::b', testName: 'c' },
        { filePath: 'a', testName: 'b::c' },
      ]))
    expect(brief.exemplars).toHaveLength(2)
    expect(brief.exemplars.every(({ unverifiedOutcomes }) => unverifiedOutcomes)).toBe(true)
  })

  it('treats a pre-partition projection shape as empty instead of querying it', async () => {
    const writer = openIndexWriter(knowledgeRoot)
    try {
      writer.db.exec(`
        DROP TABLE run_test_outcomes;
        DROP TABLE run_test_anchors;
        CREATE TABLE run_test_outcomes (
          file_path TEXT NOT NULL,
          test_name TEXT NOT NULL,
          passes INTEGER NOT NULL DEFAULT 0,
          failures INTEGER NOT NULL DEFAULT 0,
          heals INTEGER NOT NULL DEFAULT 0,
          flake_count INTEGER NOT NULL DEFAULT 0,
          quarantined INTEGER NOT NULL DEFAULT 0,
          last_outcomes_json TEXT NOT NULL DEFAULT '[]',
          last_build_ordinal INTEGER,
          PRIMARY KEY (file_path, test_name)
        );
        CREATE TABLE run_test_anchors (
          file_path TEXT NOT NULL,
          test_name TEXT NOT NULL,
          anchor_normalized_json TEXT NOT NULL,
          UNIQUE (file_path, test_name, anchor_normalized_json)
        );
        INSERT INTO run_test_outcomes (
          file_path, test_name, passes, last_outcomes_json
        ) VALUES (
          'tests/legacy-checkout.yaml', 'legacy checkout', 1,
          '[{"buildOrdinal":1,"passed":true}]'
        );
      `)
    } finally {
      writer.close()
    }
    const reader = createAuthoringReader({ knowledgeRoot, product: PRODUCT })

    const brief = await reader.getAuthoringBrief('legacy checkout', SCOPE)

    expect(brief.exemplars).toEqual([])
  })

  it('treats absent projection tables as an empty projection', async () => {
    const writer = openIndexWriter(knowledgeRoot)
    try {
      writer.db.exec(`
        DROP TABLE run_test_outcomes;
        DROP TABLE run_test_anchors;
      `)
    } finally {
      writer.close()
    }
    const reader = createAuthoringReader({ knowledgeRoot, product: PRODUCT })

    const brief = await reader.getAuthoringBrief('missing projection', SCOPE)

    expect(brief.exemplars).toEqual([])
  })

  // 390 D-02 — the exemplar quarantine exclude used to read a DERIVED column the projection
  // stamped from a lifetime flake threshold. That column is gone: the committed ledger is now the
  // one thing called "quarantined", and every case below varies exactly ONE input (the ledger
  // bytes, or the clock the fold is asked about) while the projection rows stay identical.
  describe('quarantine exclusion re-sourced to the committed ledger', () => {
    const QUARANTINED_REF = {
      filePath: 'tests/ledger-quarantined.yaml',
      testName: 'ledger quarantined checkout',
    }
    const CONTROL_REF = {
      filePath: 'tests/ledger-control.yaml',
      testName: 'ledger control checkout',
    }
    const LEDGER_ANCHOR: Anchor = { t: 'page', route: '/ledger-checkout' }
    const INTENT = 'ledger checkout /ledger-checkout'
    const ENTERED_AT = '2026-08-01T00:00:00.000Z'
    const EXPIRES_AT = '2026-08-15T00:00:00.000Z'
    /** Inside the window the `entered` event opened. */
    const BEFORE_EXPIRY = '2026-08-05T00:00:00.000Z'
    /** One day past the deadline — the fold COMPUTES 'expired' from this, D-11. */
    const AFTER_EXPIRY = '2026-08-16T00:00:00.000Z'

    function foldExemplar(
      ref: { filePath: string; testName: string },
      input: { runId: string; buildOrdinal: number; rootCauseClass?: string },
    ): void {
      foldOutcomeHandoff(knowledgeRoot, outcomeHandoff({
        scope: SCOPE,
        ...ref,
        ...input,
        outcome: 'passed',
        anchor: LEDGER_ANCHOR,
      }))
    }

    function ledgerEvent(overrides: Record<string, unknown>): Record<string, unknown> {
      return {
        schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
        kind: 'entered',
        at: ENTERED_AT,
        product: slugBranch(PRODUCT),
        ...QUARANTINED_REF,
        fingerprint: '{"route":"/ledger-checkout","t":"page"}::flake',
        verdictClass: 'flake',
        owner: QUARANTINE_UNASSIGNED_OWNER,
        expiresAt: EXPIRES_AT,
        ...overrides,
      }
    }

    function writeLedger(events: readonly Record<string, unknown>[]): void {
      writeFileSync(
        join(knowledgeRoot, QUARANTINE_LEDGER_FILENAME),
        `${events.map((event) => canonicalJson(event)).join('\n')}\n`,
        'utf8',
      )
    }

    async function exemplarNames(now: string): Promise<string[]> {
      const reader = createAuthoringReader(
        { knowledgeRoot, product: PRODUCT },
        { now: () => now },
      )
      const brief = await reader.getAuthoringBrief(INTENT, SCOPE)
      return brief.exemplars.map(({ testName }) => testName).sort()
    }

    beforeEach(() => {
      foldExemplar(QUARANTINED_REF, { runId: 'run-ledger-quarantined', buildOrdinal: 40 })
      foldExemplar(CONTROL_REF, { runId: 'run-ledger-control', buildOrdinal: 41 })
    })

    it('serves both tests when the ledger is absent (the FLAK-03 empty-input floor)', async () => {
      expect(await exemplarNames(BEFORE_EXPIRY)).toEqual([
        CONTROL_REF.testName,
        QUARANTINED_REF.testName,
      ])
    })

    it('hard-excludes a test whose ledger entry is open and unexpired', async () => {
      writeLedger([ledgerEvent({})])

      expect(await exemplarNames(BEFORE_EXPIRY)).toEqual([CONTROL_REF.testName])
    })

    it('stops excluding once the deadline lapses — expiry is COMPUTED from now (D-11)', async () => {
      writeLedger([ledgerEvent({})])

      expect(await exemplarNames(AFTER_EXPIRY)).toEqual([
        CONTROL_REF.testName,
        QUARANTINED_REF.testName,
      ])
    })

    it('stops excluding once the entry is released', async () => {
      writeLedger([
        ledgerEvent({}),
        ledgerEvent({ kind: 'released-manual', at: '2026-08-02T00:00:00.000Z' }),
      ])

      expect(await exemplarNames(BEFORE_EXPIRY)).toEqual([
        CONTROL_REF.testName,
        QUARANTINED_REF.testName,
      ])
    })

    it('keeps the entry inside its own product partition', async () => {
      writeLedger([ledgerEvent({ product: slugBranch(BLOG_PRODUCT) })])

      expect(await exemplarNames(BEFORE_EXPIRY)).toEqual([
        CONTROL_REF.testName,
        QUARANTINED_REF.testName,
      ])
    })

    it('still excludes on lifetime flakeCount with NO ledger entry (control)', async () => {
      foldExemplar(CONTROL_REF, {
        runId: 'run-ledger-control-flake',
        buildOrdinal: 42,
        rootCauseClass: 'flake',
      })

      expect(await exemplarNames(BEFORE_EXPIRY)).toEqual([QUARANTINED_REF.testName])
    })

    it('refuses a ledger the build cannot read rather than serving it un-quarantined', async () => {
      writeLedger([ledgerEvent({
        schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION + 1,
      })])
      const reader = createAuthoringReader(
        { knowledgeRoot, product: PRODUCT },
        { now: () => BEFORE_EXPIRY },
      )

      await expect(reader.getAuthoringBrief(INTENT, SCOPE)).rejects.toThrow(
        QuarantineLedgerVersionError,
      )
    })
  })
})
