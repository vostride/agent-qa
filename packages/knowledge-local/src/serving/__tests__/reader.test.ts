import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  APP_OBSERVED_DATA_CLOSE,
  APP_OBSERVED_DATA_OPEN,
} from '@vostride/agent-qa-safety'
import {
  DISTILLED_OBSERVATION_SCHEMA_VERSION,
  asEvidenceToken,
  asRecordId,
  BundleOutcomeEventSchema,
  parseProcedureBody,
  procedureSourceBinding,
  serializeProcedureBody,
  type Anchor,
  type BundleDiscriminant,
  type BundleDraft,
  type BundleOutcomeEvent,
  type BundleProvenance,
  type BundleRelation,
  type CanaryOutcome,
  type DistilledObservation,
  type OriginClass,
  type ProcedureBindingAvailability,
  type RecordId,
  type ScopeKey,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  makeProcedureBodyPayloadFixture,
  makeProcedureBundleDraftFixture,
  makeScreenStateFixture,
} from '../../__tests__/fixtures/bundle-fixture.js'
import {
  commitFixtureProcedure,
  type CommitFixtureProcedureOptions,
} from '../../__tests__/fixtures/procedure-commit-fixture.js'
import {
  publishBundle,
  type BundleStoreConfig,
  type PublishBundleInput,
} from '../../bundle-publish.test-helper.js'
import { rebuildIndex } from '../../index-rebuild.js'
import { listQueuedCandidates } from '../../queue/curation-queue.js'
import { openKnowledgeReader } from '../reader.js'

const PRODUCT = 'reader-storefront'
const SCOPE: ScopeKey = { tier: 'product', key: PRODUCT }
const CHECKOUT_ANCHOR: Anchor = {
  t: 'el',
  role: 'button',
  name: 'Checkout',
  ordinal: 0,
}

type SeedStatus = 'active' | 'candidate' | 'deprecated' | 'superseded'

interface SeedRecordOptions {
  key: string
  kind?: BundleDraft['kind']
  status?: SeedStatus
  originClass?: OriginClass
  summary?: string
  body?: string
  anchors?: Anchor[]
  scope?: ScopeKey
  relations?: readonly BundleRelation[]
  initialEvents?: readonly BundleOutcomeEvent[]
  provenance?: BundleProvenance
}

interface SeededStore {
  activeFact: RecordId
  observedFact: RecordId
  candidateFact: RecordId
  supersededFact: RecordId
  deprecatedFact: RecordId
  policy: RecordId
  cautions: RecordId[]
}

function event(
  type: BundleOutcomeEvent['type'],
  key: string,
  buildOrdinal: number,
): BundleOutcomeEvent {
  const base = {
    evidenceToken: asEvidenceToken(`${type}-${key}`),
    curationJobId: `reader-${type}-${key}`,
    buildOrdinal,
  }
  switch (type) {
    case 'confirmed':
      return BundleOutcomeEventSchema.parse({ ...base, type, origin: 'agent-verified' })
    case 'superseded':
      return BundleOutcomeEventSchema.parse({
        ...base,
        type,
        byRecordId: asRecordId(`replacement-${key}`),
      })
    case 'deprecated':
      return BundleOutcomeEventSchema.parse({ ...base, type, reason: 'reader fixture' })
    case 'window-close':
      return BundleOutcomeEventSchema.parse({ ...base, type, closedAtOrdinal: buildOrdinal })
    default:
      return BundleOutcomeEventSchema.parse({ ...base, type })
  }
}

function discriminant(
  kind: BundleDraft['kind'],
  key: string,
): BundleDiscriminant {
  switch (kind) {
    case 'fact':
      return {
        kind,
        subtype: 'selector',
        elementRef: { role: 'button', name: `Checkout ${key}` },
      }
    case 'caution':
      return { kind, errorKey: `checkout-${key}` }
    case 'procedure':
      return { kind, flowName: `Checkout ${key}`, stepSignature: `cart>${key}` }
    case 'policy':
      return { kind, ruleKey: `checkout-${key}` }
    case 'unknown':
      return { kind, conflictRecordIds: [`checkout-${key}`] }
  }
}

describe('openKnowledgeReader synchronous serving port', () => {
  let root: string
  let knowledgeRoot: string
  let seeded: SeededStore

  beforeEach(async () => {
    root = join(tmpdir(), `knowledge-serving-reader-${randomUUID()}`)
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    seeded = await seedStore()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function storeConfig(): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey: PRODUCT,
      writerLeaseId: 'reader-test',
    }
  }

  function seedRecord(options: SeedRecordOptions): RecordId {
    const kind = options.kind ?? 'fact'
    const status = options.status ?? 'active'
    const anchors = options.anchors ?? [
      { t: 'el', role: 'button', name: `Checkout ${options.key}`, ordinal: 0 },
      { t: 'page', route: '/checkout' },
    ]
    const draft: BundleDraft = {
      kind,
      ...(kind === 'fact' ? { subtype: 'selector' as const } : {}),
      anchors,
      scope: options.scope ?? SCOPE,
      summary: options.summary ?? `Checkout ${options.key} summary`,
      body: options.body ?? `Checkout ${options.key} body.`,
      distilledEvidenceRef: {
        id: `reader-${options.key}`,
        sha: options.key.padEnd(64, 'a').slice(0, 64),
      },
      originStage: 'run-curation',
    }
    const primary = anchors[0]
    const observations: DistilledObservation[] = primary?.t === 'el'
      ? [{
          schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
          step: { naturalKey: `reader-${options.key}`, ordinal: 0 },
          platform: 'web',
          element: {
            naturalKey: `${primary.role.toLowerCase()}:${primary.name.toLowerCase()}:${primary.ordinal ?? 0}`,
          },
          observedAtOrdinal: 10,
        }]
      : []
    const initialEvents: BundleOutcomeEvent[] = options.initialEvents === undefined
      ? status === 'candidate'
        ? [event('confirmed', options.key, 10)]
        : [event('promoted', options.key, 10)]
      : [...options.initialEvents]
    if (status === 'deprecated') {
      initialEvents.push(event('deprecated', options.key, 11))
    }
    if (status === 'superseded') {
      initialEvents.push(
        event('superseded', options.key, 11),
        event('window-close', options.key, 11),
      )
    }

    const input: PublishBundleInput = {
      draft,
      discriminant: discriminant(kind, options.key),
      originClass: options.originClass ?? 'agent-verified',
      createdAtOrdinal: 10,
      screenStates: [],
      initialEvents,
      relations: [...(options.relations ?? [])],
      provenance: options.provenance ?? {
        schemaVersion: 1,
        mode: 'standalone',
        originClass: options.originClass ?? 'agent-verified',
        sourceDescription: 'reader fixture',
      },
      artifacts: [],
      evidenceMarkdown: `Evidence for ${options.key}.\n`,
      ...(observations.length === 0 ? {} : { distilledObservations: observations }),
    }
    const outcome = publishBundle(storeConfig(), input)
    if (outcome.kind !== 'published') {
      throw new Error(`expected ${options.key} publication, got ${outcome.kind}`)
    }
    return outcome.id
  }

  async function seedStore(reversePublicationOrder = false): Promise<SeededStore> {
    mkdirSync(join(knowledgeRoot, 'policies'), { recursive: true })
    writeFileSync(
      join(knowledgeRoot, 'policies', 'global.md'),
      'GLOBAL POLICY: preserve checkout safety.\n',
      'utf8',
    )
    writeFileSync(
      join(knowledgeRoot, 'policies', `${PRODUCT}.md`),
      'PRODUCT POLICY: use the test checkout only.\n',
      'utf8',
    )

    const definitions: SeedRecordOptions[] = [
      { key: 'active-fact' },
      {
        key: 'observed-fact',
        originClass: 'agent-observed',
        body: 'First observed checkout line.\nSecond observed checkout line.\nThird observed checkout line.',
      },
      { key: 'candidate-fact', status: 'candidate' },
      { key: 'superseded-fact', status: 'superseded' },
      { key: 'deprecated-fact', status: 'deprecated' },
      { key: 'stored-policy', kind: 'policy' },
      ...['a', 'b', 'c'].map((key): SeedRecordOptions => ({
        key: `caution-${key}`,
        kind: 'caution',
        anchors: [CHECKOUT_ANCHOR],
        summary: `Checkout caution ${key}`,
      })),
    ]
    const orderedDefinitions = reversePublicationOrder
      ? [...definitions].reverse()
      : definitions
    const ids = new Map(
      orderedDefinitions.map((definition) => [definition.key, seedRecord(definition)]),
    )
    const id = (key: string): RecordId => {
      const recordId = ids.get(key)
      if (recordId === undefined) throw new Error(`missing seeded record ${key}`)
      return recordId
    }

    await rebuildIndex({ knowledgeRoot })
    return {
      activeFact: id('active-fact'),
      observedFact: id('observed-fact'),
      candidateFact: id('candidate-fact'),
      supersededFact: id('superseded-fact'),
      deprecatedFact: id('deprecated-fact'),
      policy: id('stored-policy'),
      cautions: ['a', 'b', 'c'].map((key) => id(`caution-${key}`)),
    }
  }

  it('assembles policy L0 and learned L1/L2 deterministically from the real index', () => {
    const reader = openKnowledgeReader({ knowledgeRoot, product: PRODUCT })

    const first = reader.getRunBrief(SCOPE, 200)
    const second = reader.getRunBrief(SCOPE, 200)

    expect(second).toEqual(first)
    expect(first.brief.tiers.L0).toContain('GLOBAL POLICY: preserve checkout safety.')
    expect(first.brief.tiers.L0).toContain('PRODUCT POLICY: use the test checkout only.')
    expect(first.brief.tiers.L1).toContain('Checkout caution')
    expect(first.brief.tiers.L2).toContain('Checkout active-fact summary')
  })

  it('serves the complete product -> suite -> test ladder and excludes sibling scopes', async () => {
    const suiteScope: ScopeKey = { tier: 'suite', key: 'suite:smoke' }
    const testScope: ScopeKey = { tier: 'test', key: 'test:checkout' }
    const records = {
      global: seedRecord({
        key: 'ladder-global',
        scope: { tier: 'global', key: 'global' },
        summary: 'Scope ladder global marker',
        anchors: [{ t: 'page', route: '/ladder/global' }],
      }),
      product: seedRecord({
        key: 'ladder-product',
        summary: 'Scope ladder product marker',
        anchors: [{ t: 'page', route: '/ladder/product' }],
      }),
      suite: seedRecord({
        key: 'ladder-suite',
        scope: suiteScope,
        summary: 'Scope ladder suite marker',
        anchors: [{ t: 'page', route: '/ladder/suite' }],
      }),
      test: seedRecord({
        key: 'ladder-test',
        scope: testScope,
        summary: 'Scope ladder test marker',
        anchors: [{ t: 'page', route: '/ladder/test' }],
      }),
      siblingSuite: seedRecord({
        key: 'ladder-sibling-suite',
        scope: { tier: 'suite', key: 'suite:regression' },
        summary: 'Scope ladder sibling suite marker',
        anchors: [{ t: 'page', route: '/ladder/sibling-suite' }],
      }),
      siblingTest: seedRecord({
        key: 'ladder-sibling-test',
        scope: { tier: 'test', key: 'test:refund' },
        summary: 'Scope ladder sibling test marker',
        anchors: [{ t: 'page', route: '/ladder/sibling-test' }],
      }),
    }
    await rebuildIndex({ knowledgeRoot })
    const reader = openKnowledgeReader({
      knowledgeRoot,
      product: PRODUCT,
      scopeDefaults: { parentScopes: [suiteScope] },
      budgets: { recordCap: 50 },
    })
    const expected = [records.global, records.product, records.suite, records.test]
    const excluded = [records.siblingSuite, records.siblingTest]

    const searchedIds = reader.search('scope ladder', { scope: testScope })
      .map(({ id }) => id)
    const briefIds = reader.getRunBrief(testScope, 2_000).brief.lines.map(({ id }) => id)

    expect(searchedIds).toEqual(expect.arrayContaining(expected))
    expect(briefIds).toEqual(expect.arrayContaining(expected))
    for (const id of excluded) {
      expect(searchedIds).not.toContain(id)
      expect(briefIds).not.toContain(id)
    }
  })

  it('enforces default walls while retaining explicit candidate and audit reads', () => {
    const reader = openKnowledgeReader({ knowledgeRoot, product: PRODUCT })

    const ordinary = reader.search('checkout', { scope: SCOPE })
    expect(ordinary.map(({ id }) => id)).toContain(seeded.activeFact)
    expect(ordinary.map(({ id }) => id)).not.toContain(seeded.candidateFact)
    expect(ordinary.map(({ id }) => id)).not.toContain(seeded.supersededFact)
    expect(ordinary.map(({ id }) => id)).not.toContain(seeded.deprecatedFact)
    expect(ordinary.map(({ id }) => id)).not.toContain(seeded.policy)

    expect(
      reader.search('checkout', { scope: SCOPE, includeCandidates: true }),
    ).toContainEqual(expect.objectContaining({
      id: seeded.candidateFact,
      status: 'candidate',
      unverified: true,
      servedAsCanary: true,
    }))
    expect(
      reader.search('checkout', { scope: SCOPE, includeSuperseded: true }),
    ).toContainEqual(expect.objectContaining({
      id: seeded.supersededFact,
      status: 'superseded',
      audit: expect.objectContaining({ status: 'superseded' }),
    }))
  })

  it('defends direct reads with current status, scope, and as-of walls', async () => {
    const testScope: ScopeKey = { tier: 'test', key: 'test:checkout' }
    const supersededTarget = seedRecord({
      key: 'read-superseded-target',
      status: 'superseded',
      scope: testScope,
    })
    const source = seedRecord({
      key: 'read-source',
      scope: testScope,
      relations: [{
        type: 'relates-to',
        targetId: supersededTarget,
        addedAtOrdinal: 12,
        curationJobId: 'reader-hidden-relation',
      }],
    })
    const sibling = seedRecord({
      key: 'read-sibling',
      scope: { tier: 'test', key: 'test:refund' },
    })
    const futureAtBuild = seedRecord({
      key: 'read-future-at-build',
      scope: testScope,
    })
    await rebuildIndex({ knowledgeRoot })
    const reader = openKnowledgeReader({ knowledgeRoot, product: PRODUCT })

    expect(reader.read(source, { scope: testScope, asOfBuild: 12 })?.relations)
      .toContainEqual({ kind: 'relates-to', targetId: supersededTarget })
    expect(reader.read(sibling, { scope: testScope, asOfBuild: 12 })).toBeUndefined()
    expect(reader.read(supersededTarget, { scope: testScope })).toBeUndefined()
    expect(reader.read(futureAtBuild, { scope: testScope, asOfBuild: 9 })).toBeUndefined()
  })

  it('bounds read bodies on whole lines and DATA-wraps app-observed content', () => {
    const reader = openKnowledgeReader({ knowledgeRoot, product: PRODUCT })

    const whole = reader.read(seeded.observedFact)
    const bounded = reader.read(seeded.observedFact, { budget: 35 })
    if (whole === undefined || bounded === undefined) {
      throw new Error('expected seeded observed record to remain readable')
    }

    expect(whole.body).toContain('Third observed checkout line.')
    expect(whole.body.startsWith(APP_OBSERVED_DATA_OPEN)).toBe(true)
    expect(whole.body.endsWith(APP_OBSERVED_DATA_CLOSE)).toBe(true)
    expect(Math.ceil(bounded.body.length / 4)).toBeLessThanOrEqual(35)
    expect(bounded.body).toContain('First observed checkout line.')
    expect(bounded.body).not.toContain('Second observed checkout line.')
    expect(bounded.body.startsWith(APP_OBSERVED_DATA_OPEN)).toBe(true)
    expect(bounded.body.endsWith(APP_OBSERVED_DATA_CLOSE)).toBe(true)
  })

  it('synchronously coalesces duplicate canary outcomes into one queue entry', () => {
    const reader = openKnowledgeReader({ knowledgeRoot, product: PRODUCT })
    const payload: CanaryOutcome = {
      candidateId: seeded.candidateFact,
      runOutcome: 'positive',
      benefit: 'rode-along',
      runId: 'reader-canary-run',
      testId: 'checkout::happy-path',
      testIndex: 1,
      buildOrdinal: 12,
      stepIndex: 3,
      briefDigest: 'reader-canary-brief',
      attribution: 'The checkout hypothesis was exercised by the passing step.',
      exercisedAnchor: CHECKOUT_ANCHOR,
    }

    reader.emitCanaryOutcome(payload)
    reader.emitCanaryOutcome(payload)

    expect(listQueuedCandidates(knowledgeRoot)).toHaveLength(1)
  })

  it('reports the domain-neutral procedure miss against a procedure-free store', () => {
    const reader = openKnowledgeReader({ knowledgeRoot, product: PRODUCT })

    expect(reader.getProcedure('complete checkout', makeScreenStateFixture())).toBeUndefined()
  })

  it('transports exactly the three source-tagged name arrays across the procedure port', async () => {
    seedRecord({
      key: 'procedure-port',
      kind: 'procedure',
      status: 'candidate',
      anchors: [
        { t: 'flow', name: 'Sign in flow' },
        { t: 'page', route: '/login' },
      ],
      summary: 'Sign in with recorded credentials',
      body: serializeProcedureBody(makeProcedureBodyPayloadFixture()),
      initialEvents: [
        event('confirmed', 'procedure-port-a', 10),
        event('confirmed', 'procedure-port-b', 11),
      ],
      provenance: {
        schemaVersion: 1,
        mode: 'run-linked',
        originClass: 'agent-verified',
        runId: 'reader-procedure-port',
        testId: 'source-tagged-availability',
        stepIndex: 0,
        authorship: {
          path: 'llm',
          model: { id: 'claude-sonnet-4' },
          executionContext: 'local-interactive',
        },
      },
    })
    await rebuildIndex({ knowledgeRoot })
    const reader = openKnowledgeReader({ knowledgeRoot, product: PRODUCT })
    // Capability entries are built loop-side by the real sanitizer — names + bits only.
    const availability = {
      variables: [procedureSourceBinding('email', 'user@example.test')!],
      memory: [procedureSourceBinding('remembered-account', 'Acme Corp')!],
      secrets: ['password'],
    } satisfies ProcedureBindingAvailability

    expect(Object.keys(availability)).toEqual(['variables', 'memory', 'secrets'])
    const sourceCorrect = reader.getProcedure(
      'sign in',
      makeScreenStateFixture(),
      availability,
    )
    expect(sourceCorrect).toMatchObject({ replayRecommendation: 'replay' })
    expect(
      reader.getProcedure(
        'sign in',
        makeScreenStateFixture(),
        {
          variables: [
            procedureSourceBinding('email', 'user@example.test')!,
            procedureSourceBinding('password', 'hunter2')!,
          ],
          memory: [],
          secrets: [],
        },
      )?.replayRecommendation,
    ).toBe('hint')
  })

  it('treats absent source-tagged availability as empty and fails conservatively to hint', async () => {
    seedRecord({
      key: 'procedure-port-empty',
      kind: 'procedure',
      status: 'candidate',
      anchors: [
        { t: 'flow', name: 'Sign in flow' },
        { t: 'page', route: '/login' },
      ],
      summary: 'Sign in with recorded credentials',
      body: serializeProcedureBody(makeProcedureBodyPayloadFixture()),
      initialEvents: [
        event('confirmed', 'procedure-port-empty-a', 10),
        event('confirmed', 'procedure-port-empty-b', 11),
      ],
    })
    await rebuildIndex({ knowledgeRoot })
    const reader = openKnowledgeReader({ knowledgeRoot, product: PRODUCT })

    expect(
      reader.getProcedure('sign in', makeScreenStateFixture())?.replayRecommendation,
    ).toBe('hint')
  })

  // Minted through the live `commitCurationDelta` path, not a hand-rolled index entry.
  function commitLiveProcedure(
    overrides: Partial<CommitFixtureProcedureOptions> = {},
  ): { bundleId: RecordId; bundleDir: string } {
    const outcome = commitFixtureProcedure({
      root,
      knowledgeRoot,
      draft: makeProcedureBundleDraftFixture({ scope: SCOPE }),
      ...overrides,
    })
    if (outcome.kind !== 'applied') {
      throw new Error(`expected an applied committed procedure, got ${outcome.kind}`)
    }
    return { bundleId: asRecordId(outcome.bundleId), bundleDir: outcome.bundleDir }
  }

  it('serves a committed agent-verified procedure body through the shared admission wall', async () => {
    const committed = commitLiveProcedure()
    await rebuildIndex({ knowledgeRoot })
    const reader = openKnowledgeReader({ knowledgeRoot, product: PRODUCT })

    // The UAT's direct probe, verbatim: a fact body on the SAME store reads fine.
    expect(reader.read(seeded.activeFact)?.body).toContain('Checkout active-fact body.')

    const body = reader.read(committed.bundleId)
    expect(body).toBeDefined()
    if (body === undefined) throw new Error('expected the committed procedure body to be readable')
    expect(body.id).toBe(committed.bundleId)
    expect(parseProcedureBody(body.body)?.steps.map(({ instruction }) => instruction))
      .toEqual(['enter-email', 'enter-password', 'submit'])
  })

  it('agrees across both faces: what getProcedure can recommend, read() can serve', async () => {
    const committed = commitLiveProcedure()
    await rebuildIndex({ knowledgeRoot })
    const reader = openKnowledgeReader({ knowledgeRoot, product: PRODUCT })

    const match = reader.getProcedure('sign in with recorded credentials', makeScreenStateFixture())
    expect(match?.id).toBe(committed.bundleId)
    expect(reader.read(committed.bundleId)).toBeDefined()
  })

  it('keeps every other read-face wall shut for procedures and unvetted fact candidates', async () => {
    const deprecated = seedRecord({
      key: 'procedure-deprecated',
      kind: 'procedure',
      status: 'deprecated',
      anchors: [
        { t: 'flow', name: 'Sign in flow' },
        { t: 'page', route: '/login' },
      ],
      body: serializeProcedureBody(makeProcedureBodyPayloadFixture()),
      initialEvents: [event('confirmed', 'procedure-deprecated', 10)],
    })
    const withheld = seedRecord({
      key: 'procedure-withheld',
      kind: 'procedure',
      status: 'candidate',
      anchors: [
        { t: 'flow', name: 'Sign in flow' },
        { t: 'page', route: '/login' },
      ],
      body: serializeProcedureBody(makeProcedureBodyPayloadFixture()),
      provenance: {
        schemaVersion: 1,
        mode: 'run-linked',
        originClass: 'agent-verified',
        runId: 'reader-procedure-withheld',
        testId: 'withheld-wall',
        stepIndex: 0,
        withheld: true,
      },
    })
    const validityClosed = seedRecord({
      key: 'procedure-validity-closed',
      kind: 'procedure',
      status: 'candidate',
      anchors: [
        { t: 'flow', name: 'Sign in flow' },
        { t: 'page', route: '/login' },
      ],
      body: serializeProcedureBody(makeProcedureBodyPayloadFixture()),
      initialEvents: [
        event('confirmed', 'procedure-validity-closed', 10),
        event('window-close', 'procedure-validity-closed', 11),
      ],
    })
    // An app-observed fact candidate never earns the vetted flag (V-checks: originClass must
    // be agent-verified or user), so it must stay unreadable — the kind-aware clause admits
    // procedures only, never a fact that currentServingEntries already refused.
    const unvettedFact = seedRecord({
      key: 'unvetted-fact-candidate',
      status: 'candidate',
      originClass: 'agent-observed',
      anchors: [{ t: 'page', route: '/unvetted' }],
    })
    await rebuildIndex({ knowledgeRoot })
    const reader = openKnowledgeReader({ knowledgeRoot, product: PRODUCT })

    expect(reader.read(deprecated)).toBeUndefined()
    expect(reader.read(withheld)).toBeUndefined()
    expect(reader.read(validityClosed)).toBeUndefined()
    expect(reader.read(unvettedFact)).toBeUndefined()
  })

  // The byte comparisons cover `{ brief, trace }`, so a leaked procedure shows in the trace too.
  it('leaks no procedure into brief or caution serving — bytes identical across the commit', async () => {
    const before = openKnowledgeReader({ knowledgeRoot, product: PRODUCT })
    const briefBefore = JSON.stringify(before.getRunBrief(SCOPE, 2_000))
    const cautionsBefore = JSON.stringify(before.getCautions([CHECKOUT_ANCHOR], 2_000))

    const committed = commitLiveProcedure()
    await rebuildIndex({ knowledgeRoot })
    const after = openKnowledgeReader({ knowledgeRoot, product: PRODUCT })

    expect(after.read(committed.bundleId)).toBeDefined()
    expect(JSON.stringify(after.getRunBrief(SCOPE, 2_000))).toBe(briefBefore)
    expect(JSON.stringify(after.getCautions([CHECKOUT_ANCHOR], 2_000))).toBe(cautionsBefore)
    expect(after.search('sign in', { scope: SCOPE }).map(({ id }) => id))
      .not.toContain(committed.bundleId)
  })

  it('crosses caution overflow with one accurate reserved terminal line', () => {
    const reader = openKnowledgeReader({ knowledgeRoot, product: PRODUCT })

    const overflow = reader.getCautions([CHECKOUT_ANCHOR], 1)
    const complete = reader.getCautions([CHECKOUT_ANCHOR], 100)

    expect(overflow.block.cautions.at(-1)).toEqual({
      id: 'caution:truncated',
      anchors: [],
      summary: 'truncated 0 of 3',
    })
    expect(complete.block.cautions.map(({ id }) => id)).toEqual(
      expect.arrayContaining(seeded.cautions),
    )
    expect(complete.block.cautions).not.toContainEqual(expect.objectContaining({
      id: 'caution:truncated',
    }))
  })

  it('keeps brief bytes stable when committed bundles arrive in reverse order', async () => {
    const forward = openKnowledgeReader({ knowledgeRoot, product: PRODUCT })
      .getRunBrief(SCOPE, 200)
    const primaryKnowledgeRoot = knowledgeRoot

    try {
      knowledgeRoot = join(root, 'reverse-agent-qa-knowledge')
      await seedStore(true)
      const reverse = openKnowledgeReader({ knowledgeRoot, product: PRODUCT })
        .getRunBrief(SCOPE, 200)

      expect(JSON.stringify(reverse)).toBe(JSON.stringify(forward))
    } finally {
      knowledgeRoot = primaryKnowledgeRoot
    }
  })

  it('serves an empty L0 when the store has no authored policy files', () => {
    rmSync(join(knowledgeRoot, 'policies'), { recursive: true, force: true })
    const reader = openKnowledgeReader({ knowledgeRoot, product: PRODUCT })

    expect(reader.getRunBrief(SCOPE, 200).brief.tiers.L0).toBe('')
  })

  it('returns a structured empty result for an empty search query', () => {
    const reader = openKnowledgeReader({ knowledgeRoot, product: PRODUCT })

    expect(reader.search('', { scope: SCOPE })).toEqual([])
  })

  it('returns the domain-neutral miss value for a missing record id', () => {
    const reader = openKnowledgeReader({ knowledgeRoot, product: PRODUCT })
    const missingId = asRecordId('reader-record-does-not-exist')

    expect(reader.read(missingId)).toBeUndefined()
  })
})
